import { constants } from "node:fs";
import { type FileHandle, open } from "node:fs/promises";
import { refuseEbml, sniffBytes } from "./container";
import {
	checkContentCredentials,
	checkUuidType,
	contentCredentialsPrefix,
} from "./content-credentials";
import { check, TruncatedVideoError } from "./errors";
import { movieByteLimit, saveBounds, videoByteLimit } from "./limits";
import { inspectMovie, type Span } from "./mp4";
import { boxHeader } from "./mp4-boxes";

const topLevel = new Set(["ftyp", "moov", "mdat", "free", "skip", "wide", "uuid"]);
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
 * file and buffers only `ftyp`, `moov` and the first bytes of one C2PA manifest box.
 * Throws `TruncatedVideoError` when the file ends inside a box or before `moov` or `mdat`,
 * and `UnsupportedVideoError` for anything outside the profile under the job's Save limit in
 * seconds (null for a job queued before limits existed).
 */
export async function verifyVideoFile(path: string, seconds: number | null) {
	saveBounds(seconds);
	const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
	try {
		const { size } = await file.stat();
		check(size > 0 && size <= videoByteLimit, "file size");
		refuseEbml(await readAt(file, 0, Math.min(sniffBytes, size)), size);
		let ftyp: Buffer | undefined;
		let moov: Buffer | undefined;
		const media: Span[] = [];
		let credentials = false;
		let boxes = 0;
		for (let at = 0; at < size; ) {
			check(++boxes <= topLevelBoxLimit, "too many boxes");
			// Up to a 64-bit header and a `uuid` extended type.
			const head = await readAt(file, at, Math.min(32, size - at));
			// Refuse a foreign type before its size, so a complete non-MP4 file is not truncated.
			if (head.length >= 8) {
				const type = head.toString("latin1", 4, 8);
				check(topLevel.has(type), type === "moof" ? "fragmented MP4" : `${type} at the top level`);
				if (type === "uuid") checkUuidType(head);
			}
			const { type, size: length, header } = boxHeader(head, 0, size - at, truncated);
			if (type === "ftyp") {
				check(!ftyp && length <= fileTypeByteLimit, "file type box");
				ftyp = await readAt(file, at, length);
			} else if (type === "moov") {
				check(!moov, "one movie box");
				check(length <= movieByteLimit, "movie box over 4 MiB");
				moov = await readAt(file, at, length);
			} else if (type === "uuid") {
				const prefix = await readAt(file, at, Math.min(length, contentCredentialsPrefix));
				checkContentCredentials(prefix, header, length);
				check(!credentials, "one content credentials box");
				check(ftyp && !moov && !media.length, "content credentials position");
				credentials = true;
			} else if (type === "mdat") media.push({ start: at + header, end: at + length });
			at += length;
		}
		check(ftyp, "file type box");
		// A download cut exactly at a box boundary ends before the movie or its media.
		if (!moov || !media.length) throw truncated();
		return inspectMovie(ftyp, moov, media, seconds);
	} finally {
		await file.close();
	}
}
