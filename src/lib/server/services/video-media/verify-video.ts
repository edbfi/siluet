import { constants } from "node:fs";
import { type FileHandle, open } from "node:fs/promises";
import { refuseEbml, sniffBytes } from "./container";
import { check, TruncatedVideoError } from "./errors";
import { movieByteLimit, videoByteLimit } from "./limits";
import { inspectMovie, type Span } from "./mp4";
import { boxHeader } from "./mp4-boxes";

const topLevel = new Set(["ftyp", "moov", "mdat", "free", "skip", "wide"]);
const fileTypeByteLimit = 4096;
const topLevelBoxLimit = 4096;
const truncated = () => new TruncatedVideoError();

async function readAt(file: FileHandle, position: number, length: number) {
	const buffer = Buffer.alloc(length);
	let filled = 0;
	while (filled < length) {
		const { bytesRead } = await file.read(buffer, filled, length - filled, position + filled);
		if (!bytesRead) throw truncated();
		filled += bytesRead;
	}
	return buffer;
}

/**
 * Verify a downloaded video's structure (D6). Reads top-level box headers from the
 * file and buffers only `ftyp` and `moov`. Throws `TruncatedVideoError` when the file
 * ends inside a box or before `moov` or `mdat`, and `UnsupportedVideoError` for anything
 * outside the profile.
 */
export async function verifyVideoFile(path: string) {
	const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
	try {
		const { size } = await file.stat();
		check(size > 0 && size <= videoByteLimit, "file size");
		refuseEbml(await readAt(file, 0, Math.min(sniffBytes, size)), size);
		let ftyp: Buffer | undefined;
		let moov: Buffer | undefined;
		const media: Span[] = [];
		let boxes = 0;
		for (let at = 0; at < size; ) {
			check(++boxes <= topLevelBoxLimit, "too many boxes");
			const head = await readAt(file, at, Math.min(16, size - at));
			// Refuse a foreign type before its size, so a complete non-MP4 file is not truncated.
			if (head.length >= 8) {
				const type = head.toString("latin1", 4, 8);
				check(topLevel.has(type), type === "moof" ? "fragmented MP4" : `${type} at the top level`);
			}
			const { type, size: length, header } = boxHeader(head, 0, size - at, truncated);
			if (type === "ftyp") {
				check(!ftyp && length <= fileTypeByteLimit, "file type box");
				ftyp = await readAt(file, at, length);
			} else if (type === "moov") {
				check(!moov, "one movie box");
				check(length <= movieByteLimit, "movie box over 4 MiB");
				moov = await readAt(file, at, length);
			} else if (type === "mdat") media.push({ start: at + header, end: at + length });
			at += length;
		}
		check(ftyp, "file type box");
		// A download cut exactly at a box boundary ends before the movie or its media.
		if (!moov || !media.length) throw truncated();
		return inspectMovie(ftyp, moov, media);
	} finally {
		await file.close();
	}
}
