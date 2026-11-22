import type { Density } from "./jpeg-density";
import { refuseJpeg } from "./jpeg-errors";
import type { readJpeg } from "./jpeg-markers";
import { inspectXmp, mergeXmp, type XmpProperties } from "./jpeg-xmp";

type Marker = ReturnType<typeof readJpeg>["markers"][number];
const c2paType = Buffer.from("6332706100110010800000aa00389b71", "hex");

export type PhotoshopMetadata = { xmp: XmpProperties; density?: Density; aspect?: number };

function resolution(data: Buffer): Density {
	// Both 16.16 values are in pixels per inch. The four unit fields are
	// Photoshop display preferences, per the SDK's ResolutionInfo definition.
	// https://ptacts.uspto.gov/ptacts/public-informations/petitions/1523296/download-documents?artifactId=FbXKj_3k5c6DXoE0sbuxhsfh1qymlAtKeaSFoC2mNC3y-G9nCsBsiwo
	if (
		data.length !== 16 ||
		![4, 12].every((offset) => [1, 2].includes(data.readUInt16BE(offset))) ||
		![6, 14].every((offset) => [1, 2, 3, 4, 5].includes(data.readUInt16BE(offset)))
	)
		refuseJpeg("aspect");
	const x = BigInt(data.readInt32BE(0));
	const y = BigInt(data.readInt32BE(8));
	if (x <= 0n || y <= 0n) refuseJpeg("aspect");
	return { x: [x, 65536n], y: [y, 65536n], unit: 2 };
}

function pixelAspect(data: Buffer) {
	if (data.length !== 12 || ![1, 2].includes(data.readUInt32BE())) refuseJpeg("aspect");
	const ratio = data.readDoubleBE(4);
	if (!Number.isFinite(ratio) || ratio <= 0) refuseJpeg("aspect");
	return ratio;
}

// Adobe image resource blocks include a Pascal name and even-byte padding.
// Only permit resources whose names and payloads can both be discarded.
// https://www.adobe.com/devnet-apps/photoshop/fileformatashtml/
const descriptiveResources = new Set([
	0x03ea, 0x0404, 0x0406, 0x0408, 0x0409, 0x040a, 0x040b, 0x040c, 0x041a, 0x0421, 0x0425,
]);
export function inspectPhotoshop(data: Buffer, metadata: PhotoshopMetadata) {
	for (let offset = 0; offset < data.length; ) {
		if (offset + 7 > data.length || data.toString("latin1", offset, offset + 4) !== "8BIM") {
			refuseJpeg("metadata");
		}
		const id = data.readUInt16BE(offset + 4);
		const name = data[offset + 6] + 1;
		const sizeOffset = offset + 6 + name + (name % 2);
		if (sizeOffset + 4 > data.length) refuseJpeg("metadata");
		const size = data.readUInt32BE(sizeOffset);
		const end = sizeOffset + 4 + size;
		offset = end + (size % 2);
		if (offset > data.length) refuseJpeg("metadata");
		const payload = data.subarray(sizeOffset + 4, end);
		if (id === 0x0424) {
			const packet = inspectXmp(payload);
			if (packet.has("HasExtendedXMP")) refuseJpeg("metadata");
			mergeXmp(metadata.xmp, packet);
		} else if (id === 0x03ed) {
			if (metadata.density) refuseJpeg("aspect");
			metadata.density = resolution(payload);
		} else if (id === 0x0428) {
			if (metadata.aspect !== undefined) refuseJpeg("aspect");
			metadata.aspect = pixelAspect(payload);
		} else if (id === 0x040f || id === 0x0411) {
			refuseJpeg("color");
		} else if (!descriptiveResources.has(id)) {
			refuseJpeg("metadata");
		}
	}
}

// JPEG XT repeats LBox and TBox in each continuation. Accept one contiguous
// C2PA store with a matching UUID and label. Other JUMBF is unclassified.
// https://spec.c2pa.org/specifications/specifications/2.4/specs/C2PA_Specification.html
export function inspectC2pa(parts: Marker[]) {
	if (!parts.length) return;
	const first = parts[0].data;
	if (
		first.length < 46 ||
		first.toString("latin1", 12, 16) !== "jumb" ||
		first.toString("latin1", 20, 24) !== "jumd" ||
		!first.subarray(24, 40).equals(c2paType) ||
		!(first[40] & 2) ||
		first.toString("latin1", 41, 46) !== "c2pa\0"
	)
		refuseJpeg("metadata");
	const boxSize = first.readUInt32BE(8);
	const descriptionSize = first.readUInt32BE(16);
	if (descriptionSize < 30 || descriptionSize > boxSize - 8) refuseJpeg("metadata");
	let size = 8;
	for (const [index, { data, offset }] of parts.entries()) {
		if (
			data.length <= 16 ||
			data.toString("latin1", 0, 2) !== "JP" ||
			data.readUInt16BE(2) !== first.readUInt16BE(2) ||
			data.readUInt32BE(4) !== index + 1 ||
			!data.subarray(8, 16).equals(first.subarray(8, 16)) ||
			(index > 0 && offset !== parts[index - 1].end)
		)
			refuseJpeg("metadata");
		size += data.length - 16;
	}
	if (size !== boxSize) refuseJpeg("metadata");
}
