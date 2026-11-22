import { createHash } from "node:crypto";
import { SaxesParser } from "saxes";
import type { IccIdentity } from "./icc-profile";
import { type Density, resolutionRational } from "./jpeg-density";
import { refuseJpeg } from "./jpeg-errors";

const utf8 = new TextDecoder("utf-8", { fatal: true });
const xmpLimit = 512 * 1024;
const tiff = "http://ns.adobe.com/tiff/1.0/";
const exif = "http://ns.adobe.com/exif/1.0/";
const cipa = "http://cipa.jp/exif/1.0/";
const photoshop = "http://ns.adobe.com/photoshop/1.0/";
const note = "http://ns.adobe.com/xmp/note/";
const xmlns = "http://www.w3.org/2000/xmlns/";
const namespaces = new Set([
	"adobe:ns:meta/",
	"http://www.w3.org/1999/02/22-rdf-syntax-ns#",
	"http://purl.org/dc/elements/1.1/",
	"http://ns.adobe.com/xap/1.0/",
	"http://ns.adobe.com/xap/1.0/mm/",
	"http://ns.adobe.com/xap/1.0/rights/",
	note,
	photoshop,
	tiff,
	exif,
	cipa,
	"http://ns.adobe.com/camera-raw-settings/1.0/",
	"http://ns.adobe.com/xap/1.0/sType/ResourceEvent#",
	"http://ns.adobe.com/xap/1.0/sType/ResourceRef#",
	"http://ns.adobe.com/xap/1.0/g/img/",
	"http://iptc.org/std/Iptc4xmpCore/1.0/xmlns/",
	"http://iptc.org/std/Iptc4xmpExt/2008-02-29/",
	"http://creativecommons.org/ns#",
	"http://www.w3.org/XML/1998/namespace",
]);

const recognized = {
	Orientation: [tiff, "orientation"],
	ColorSpace: [exif, "color"],
	ICCProfile: [photoshop, "color"],
	InteroperabilityIndex: [cipa, "color"],
	XResolution: [tiff, "aspect"],
	YResolution: [tiff, "aspect"],
	ResolutionUnit: [tiff, "aspect"],
	HasExtendedXMP: [note, "metadata"],
} as const;

type Property = keyof typeof recognized;
export type XmpProperties = Map<Property, string>;

const propertiesByName = new Map(
	(Object.keys(recognized) as Property[]).map((name) => [name.toLowerCase(), name]),
);

function propertyFor(uri: string, name: string): Property | undefined {
	// Classify markup only. Text and attribute values can freely mention these terms.
	// https://developer.android.com/media/platform/hdr-image-format
	// https://developer.android.com/media/platform/motion-photo-format
	if (/hdr-gain-map|gainmap/i.test(uri) || /gainmap/i.test(name)) refuseJpeg("hdr");
	if (/\/photos\/1\.0\/camera\//i.test(uri) || /motionphoto|microvideo/i.test(name)) {
		refuseJpeg("motion");
	}
	if (/\/photos\/1\.0\/container(?:item)?\//i.test(uri)) refuseJpeg("secondary");
	if (uri && !namespaces.has(uri)) refuseJpeg("metadata");

	if (
		/^(?:Gamma|WhitePoint|PrimaryChromaticities|TransferFunction|YCbCrCoefficients|YCbCrPositioning|ReferenceBlackWhite)$/i.test(
			name,
		)
	) {
		refuseJpeg("color");
	}
	if (/^PixelAspectRatio$/i.test(name)) refuseJpeg("aspect");

	const property = propertiesByName.get(name.toLowerCase());
	if (!property) return;
	const [expected, failure] = recognized[property];
	if (uri !== expected || name !== property) refuseJpeg(failure);
	return property;
}

function addProperty(properties: XmpProperties, name: Property, value: string) {
	if (properties.has(name)) refuseJpeg(recognized[name][1]);
	properties.set(name, value.trim());
}

export function mergeXmp(target: XmpProperties, packet: XmpProperties | undefined) {
	if (!packet) return;
	for (const [name, value] of packet) addProperty(target, name, value);
}

// Read only simple XMP property elements and compact attributes. No DTD,
// external entities or processing instructions other than the XMP wrapper.
// https://developer.adobe.com/xmp/docs/xmp-specifications/
export function inspectXmp(data: Buffer): XmpProperties {
	const properties: XmpProperties = new Map();
	const parser = new SaxesParser({ xmlns: true, defaultXMLVersion: "1.0", forceXMLVersion: true });
	let element: { name: Property; value: string } | undefined;
	let depth = 0;
	let attributes = 0;
	const invalid = () => refuseJpeg("metadata");
	parser.on("error", invalid);
	parser.on("doctype", invalid);
	parser.on("xmldecl", ({ version, encoding }) => {
		if (version !== "1.0" || (encoding !== undefined && encoding.toLowerCase() !== "utf-8")) {
			invalid();
		}
	});
	parser.on("processinginstruction", ({ target }) => {
		if (target !== "xpacket" || depth !== 0) invalid();
	});
	parser.on("opentagstart", () => {
		if (++depth > 64) refuseJpeg("limit");
		if (element) refuseJpeg(recognized[element.name][1]);
		attributes = 0;
	});
	parser.on("attribute", () => {
		if (++attributes > 256) refuseJpeg("limit");
	});
	parser.on("opentag", ({ uri, local, attributes }) => {
		const name = propertyFor(uri, local);
		for (const property of Object.values(attributes)) {
			if (property.uri === xmlns) {
				propertyFor(property.value, "");
				continue;
			}
			if (name) refuseJpeg(recognized[name][1]);
			const field = propertyFor(property.uri, property.local);
			if (field) addProperty(properties, field, property.value);
		}
		if (name) element = { name, value: "" };
	});
	function appendValue(text: string) {
		if (element) element.value += text;
	}
	parser.on("text", appendValue);
	parser.on("cdata", appendValue);
	parser.on("closetag", () => {
		depth--;
		if (element) addProperty(properties, element.name, element.value);
		element = undefined;
	});
	let packet: string;
	try {
		packet = utf8.decode(data);
	} catch {
		return invalid();
	}
	parser.write(packet).close();
	return properties;
}

export function inspectExtendedXmp(standard: XmpProperties | undefined, parts: Buffer[]) {
	const declared = standard?.get("HasExtendedXMP");
	if (!parts.length) {
		if (declared !== undefined) refuseJpeg("metadata");
		return;
	}
	if (parts.some((part) => part.length <= 40)) refuseJpeg("metadata");
	const guid = parts[0].toString("latin1", 0, 32);
	const size = parts[0].readUInt32BE(32);
	if (size > xmpLimit) refuseJpeg("limit");
	if (!/^[0-9A-F]{32}$/.test(guid) || declared !== guid) refuseJpeg("metadata");
	const ordered = parts.toSorted((a, b) => a.readUInt32BE(36) - b.readUInt32BE(36));
	let offset = 0;
	for (const part of ordered) {
		if (
			part.toString("latin1", 0, 32) !== guid ||
			part.readUInt32BE(32) !== size ||
			part.readUInt32BE(36) !== offset
		)
			refuseJpeg("metadata");
		offset += part.length - 40;
	}
	if (offset !== size) refuseJpeg("metadata");
	const packet = Buffer.concat(
		ordered.map((part) => part.subarray(40)),
		size,
	);
	if (createHash("md5").update(packet).digest("hex").toUpperCase() !== guid) refuseJpeg("metadata");
	const properties = inspectXmp(packet);
	if (properties.has("HasExtendedXMP")) refuseJpeg("metadata");
	return properties;
}

export function readXmpDensity(properties: XmpProperties): Density | undefined {
	const x = properties.get("XResolution");
	const y = properties.get("YResolution");
	const unit = properties.get("ResolutionUnit");
	if (x === undefined && y === undefined && unit === undefined) return;
	if (x === undefined || y === undefined || (unit !== undefined && !/^[123]$/.test(unit))) {
		refuseJpeg("aspect");
	}
	return {
		x: resolutionRational(x),
		y: resolutionRational(y),
		unit: unit === undefined ? undefined : Number(unit),
	};
}

export function checkXmpColor(
	properties: XmpProperties,
	embedded: IccIdentity | undefined,
	exif: { srgb: boolean; uncalibrated: boolean } | undefined,
) {
	const space = properties.get("ColorSpace");
	const label = properties.get("ICCProfile");
	const index = properties.get("InteroperabilityIndex");
	const uncalibrated = space !== undefined && /^\+?0*65535$/.test(space);
	const srgb = space !== undefined && /^\+?0*1$/.test(space);
	if (space !== undefined && !uncalibrated && !srgb) refuseJpeg("color");
	if (index !== undefined && index !== "R98") refuseJpeg("color");
	const namedSrgb = label !== undefined && /^srgb/i.test(label);
	if (label !== undefined) {
		if (!label || !embedded || (namedSrgb && !embedded.srgb)) refuseJpeg("color");
		const srgbAlias = embedded.srgb && /^srgb(?: iec61966-2\.1)?$/i.test(label);
		const matchesName = [...embedded.names].some(
			(name) => name.trim().toLowerCase() === label.toLowerCase(),
		);
		if (!srgbAlias && !matchesName) refuseJpeg("color");
	}
	if (srgb || exif?.srgb || namedSrgb || index === "R98") {
		if (uncalibrated || exif?.uncalibrated || !embedded?.srgb) refuseJpeg("color");
	}
}
