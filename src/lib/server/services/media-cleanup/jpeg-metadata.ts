import { checkDensity } from "./jpeg-density";
import { inspectC2pa, inspectPhotoshop, type PhotoshopMetadata } from "./jpeg-descriptive";
import { refuseJpeg } from "./jpeg-errors";
import { inspectExif } from "./jpeg-exif";
import { readJpegIcc } from "./jpeg-icc";
import type { readJpeg } from "./jpeg-markers";
import {
	checkXmpColor,
	inspectExtendedXmp,
	inspectXmp,
	mergeXmp,
	readXmpDensity,
	type XmpProperties,
} from "./jpeg-xmp";

type Jpeg = ReturnType<typeof readJpeg>;
type RenderMarker = Pick<Jpeg["markers"][number], "code" | "data">;
const metadataLimit = 2 * 1024 * 1024;
const prefixes = {
	jfif: Buffer.from("JFIF\0"),
	jfxx: Buffer.from("JFXX\0"),
	adobe: Buffer.from("Adobe"),
	icc: Buffer.from("ICC_PROFILE\0"),
	exif: Buffer.from("Exif\0\0"),
	xmp: Buffer.from("http://ns.adobe.com/xap/1.0/\0"),
	extended: Buffer.from("http://ns.adobe.com/xmp/extension/\0"),
	photoshop: Buffer.from("Photoshop 3.0\0"),
	gain: Buffer.from("urn:iso:std:iso:ts:21496:-1\0"),
	mpf: Buffer.from("MPF\0"),
};

/** APP2 prefixes of an ISO 21496 gain map and an MPF secondary-image index. */
export const gainMapPrefix = prefixes.gain;
export const mpfPrefix = prefixes.mpf;
export const iccPrefix = prefixes.icc;

function starts(data: Buffer, prefix: keyof typeof prefixes) {
	const bytes = prefixes[prefix];
	return data.subarray(0, bytes.length).equals(bytes);
}

// ITU T.871: retain the resolution unit and density ratio. Discard both
// dimensions and all data for the in-marker thumbnail.
function jfifWithoutThumbnail(data: Buffer) {
	if (
		data.length < 14 ||
		data[5] !== 1 ||
		data[6] > 2 ||
		data[7] > 2 ||
		!data.readUInt16BE(8) ||
		!data.readUInt16BE(10) ||
		(data[12] === 0) !== (data[13] === 0) ||
		data.length !== 14 + 3 * data[12] * data[13]
	) {
		refuseJpeg("aspect");
	}
	return Buffer.concat([data.subarray(0, 12), Buffer.alloc(2)]);
}

function adobeColor(data: Buffer, components: number) {
	// Adobe Technical Note 5116 defines Blend=1 downsampling in flags0.
	// libjpeg-turbo interprets one component as grayscale independently of APP14.
	// https://citeseerx.ist.psu.edu/document?doi=529b1f9c638ad7800abbde42177c58219fe1f831
	// https://github.com/libjpeg-turbo/libjpeg-turbo/blob/3.2.1/src/jdapimin.c
	if (
		data.length !== 12 ||
		data.readUInt16BE(5) !== 100 ||
		![0, 0x8000].includes(data.readUInt16BE(7)) ||
		data.readUInt16BE(9) !== 0 ||
		data[11] > (components === 1 ? 0 : 1)
	)
		refuseJpeg("color");
	return data;
}

export function inspectJpegMetadata({ markers, frame }: Jpeg) {
	if (markers.reduce((sum, marker) => sum + marker.data.length, 0) > metadataLimit)
		refuseJpeg("limit");
	let jfif: Buffer | undefined;
	let adobe: Buffer | undefined;
	let exif: ReturnType<typeof inspectExif> | undefined;
	let xmp: XmpProperties | undefined;
	const photoshop: PhotoshopMetadata = { xmp: new Map() };
	let multiplePictures = false;
	const retained: RenderMarker[] = [];
	const icc: Buffer[] = [];
	const extended: Buffer[] = [];
	const c2pa: Jpeg["markers"] = [];
	for (const marker of markers) {
		const { code, data, afterScan } = marker;
		if (code === 0xfe) continue;
		if (code === 0xe0 && starts(data, "jfif")) {
			if (jfif || afterScan) refuseJpeg("aspect");
			jfif = jfifWithoutThumbnail(data);
			retained.push({ code, data: jfif });
		} else if (code === 0xe0 && starts(data, "jfxx")) {
			// Registered thumbnail variants in T.871.
			if (![0x10, 0x11, 0x13].includes(data[5])) refuseJpeg("metadata");
		} else if (code === 0xe1 && starts(data, "exif")) {
			if (exif || afterScan) refuseJpeg("orientation");
			exif = inspectExif(data.subarray(prefixes.exif.length), frame);
		} else if (code === 0xe1 && starts(data, "xmp")) {
			if (xmp !== undefined) refuseJpeg("metadata");
			xmp = inspectXmp(data.subarray(prefixes.xmp.length));
		} else if (code === 0xe1 && starts(data, "extended")) {
			extended.push(data.subarray(prefixes.extended.length));
		} else if (code === 0xe2 && starts(data, "icc")) {
			if (afterScan) refuseJpeg("color");
			icc.push(data);
			retained.push({ code, data });
		} else if (code === 0xe2 && starts(data, "gain")) {
			refuseJpeg("hdr");
		} else if (code === 0xe2 && starts(data, "mpf")) {
			multiplePictures = true;
		} else if (code === 0xeb) {
			c2pa.push(marker);
		} else if (code === 0xed && starts(data, "photoshop")) {
			inspectPhotoshop(data.subarray(prefixes.photoshop.length), photoshop);
		} else if (code === 0xee && starts(data, "adobe")) {
			if (adobe || afterScan) refuseJpeg("color");
			adobe = adobeColor(data, frame.components.length);
			retained.push({ code, data: adobe });
		} else {
			refuseJpeg("metadata");
		}
	}
	const extendedXmp = inspectExtendedXmp(xmp, extended);
	const properties: XmpProperties = xmp ?? new Map();
	mergeXmp(properties, extendedXmp);
	// Standard and extended XMP represent one packet. An APP13 packet must
	// declare both axes itself before it can corroborate the primary density.
	const xmpDensity = readXmpDensity(properties);
	const photoshopXmpDensity = readXmpDensity(photoshop.xmp);
	mergeXmp(properties, photoshop.xmp);
	const xmpOrientation = properties.get("Orientation");
	if (
		xmpOrientation !== undefined &&
		(exif?.orientation !== undefined || !/^\+?0*1$/.test(xmpOrientation))
	)
		refuseJpeg("orientation");

	if (multiplePictures) refuseJpeg("secondary");
	inspectC2pa(c2pa);
	const profile = readJpegIcc(icc, frame.components.length === 1);
	checkXmpColor(properties, profile, exif);
	const densities = [exif?.density, xmpDensity, photoshopXmpDensity, photoshop.density];
	checkDensity(
		jfif,
		densities.filter((density) => density !== undefined),
		photoshop.aspect,
	);
	return { retained, orientation: exif?.orientation ?? 1 };
}

export function renderMarkers(metadata: ReturnType<typeof inspectJpegMetadata>) {
	return metadata.retained;
}

// A re-encoded copy carries YCbCr or grayscale samples from the encoder, so the
// source's Adobe APP14 transform no longer describes it. Keep the density, with
// axes swapped for a quarter turn, and the exact ICC payload.
export function rotatedMarkers(
	metadata: ReturnType<typeof inspectJpegMetadata>,
	swapAxes: boolean,
) {
	return metadata.retained.flatMap((marker) => {
		if (marker.code === 0xe2) return [marker];
		if (marker.code !== 0xe0) return [];
		if (!swapAxes) return [marker];
		const data = Buffer.from(marker.data);
		data.writeUInt16BE(marker.data.readUInt16BE(10), 8);
		data.writeUInt16BE(marker.data.readUInt16BE(8), 10);
		return [{ code: marker.code, data }];
	});
}
