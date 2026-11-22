import { checkIccProfile, cicpProblem } from "./icc-profile";
import { type PngHeader, readKeywordEnd, writePngChunk } from "./png-chunks";
import { PngCleanupError } from "./png-errors";
import { inflatePng } from "./png-inflate";

const maxProfileBytes = 1024 * 1024;
function refuseColor(problem: "color" | "hdr"): never {
	throw new PngCleanupError(problem === "hdr" ? "hdr-png" : "png-color");
}

export function checkPngColor(type: string, data: Buffer, header: PngHeader) {
	switch (type) {
		case "cICP": {
			const problem = cicpProblem(data);
			if (problem) refuseColor(problem);
			break;
		}
		case "gAMA":
			if (data.length !== 4 || data.readUInt32BE() === 0) throw new PngCleanupError("png-color");
			break;
		case "cHRM":
			if (data.length !== 32) throw new PngCleanupError("png-color");
			break;
		case "sRGB":
			if (data.length !== 1 || data[0] > 3) throw new PngCleanupError("png-color");
			break;
		case "sBIT": {
			const indexed = header.color === 3;
			const count = indexed ? 3 : header.channels;
			const depth = indexed ? 8 : header.depth;
			if (data.length !== count || data.some((bits) => bits < 1 || bits > depth)) {
				throw new PngCleanupError("png-color");
			}
			break;
		}
		case "pHYs":
			if (
				data.length !== 9 ||
				data[8] > 1 ||
				data.readUInt32BE(0) === 0 ||
				data.readUInt32BE(4) === 0
			) {
				throw new PngCleanupError("invalid-png");
			}
			break;
	}
}

export async function neutralIccChunk(data: Buffer, color: PngHeader["color"]) {
	const nameEnd = readKeywordEnd(data, "png-color");
	if (data[nameEnd + 1] !== 0) throw new PngCleanupError("png-color");
	const compressed = data.subarray(nameEnd + 2);
	if (compressed.length > maxProfileBytes + 32 * 1024) throw new PngCleanupError("png-limit");
	const profile = await inflatePng(compressed, maxProfileBytes, {
		invalid: "png-color",
		oversized: "png-limit",
	});
	checkIccProfile(profile, color === 0 || color === 4, refuseColor);
	// The profile payload and compression stay byte-identical. Only its PNG keyword changes.
	return writePngChunk("iCCP", Buffer.concat([Buffer.from("ICC\0\0"), compressed]));
}
