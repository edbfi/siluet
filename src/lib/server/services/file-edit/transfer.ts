import {
	fileUploadRoutes,
	neutralFilename,
	type StageDescriptor,
} from "../../../shared/image-studio/file-edit";
import type { SeedreamProvider } from "../../../shared/image-studio/seedream";
import type { CheckFetch } from "../../providers/connection-check";
import { filePost } from "../../providers/file-post";
import { type UploadOutcome, uncertainUpload } from "../../providers/file-upload";
import type { ReviewedImageRequest } from "../../providers/image-job";
import { createPoyoImage } from "../../providers/poyo/image";
import { interpretPoyoUpload } from "../../providers/poyo/upload";
import { createToapisImage } from "../../providers/toapis/image";
import { interpretToapisUpload } from "../../providers/toapis/upload";

// Bytes copied out of the shared dispatch buffer per pull.
const chunkBytes = 65_536;

/**
 * Upload one staged file from the dispatcher's buffer. The body copies the buffer out in
 * small chunks as transport pulls them and stops producing once the request settles, so
 * this resolves only after the body has drained or stopped: the next file can then reuse
 * the buffer without reaching bytes still in flight.
 */
export async function uploadFile(
	provider: SeedreamProvider,
	key: string,
	file: Pick<StageDescriptor, "mime" | "size">,
	bytes: Uint8Array<ArrayBuffer>,
	read: CheckFetch = filePost(fileUploadRoutes[provider], 60_000),
): Promise<UploadOutcome> {
	const url = fileUploadRoutes[provider];
	const boundary = `siluet-${crypto.randomUUID()}`;
	const prefix = Buffer.from(
		`--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${neutralFilename(file.mime)}"\r\nContent-Type: ${file.mime}\r\n\r\n`,
	);
	const suffix = Buffer.from(`\r\n--${boundary}--\r\n`);
	let offset = 0;
	let stopped = false;
	// The producer reached the end of the multipart body.
	let produced = false;
	const body = new ReadableStream<Uint8Array>(
		{
			start(controller) {
				controller.enqueue(prefix);
			},
			pull(controller) {
				if (stopped) {
					controller.error(new Error("Upload settled."));
					return;
				}
				if (offset < bytes.length) {
					const end = Math.min(offset + chunkBytes, bytes.length);
					controller.enqueue(bytes.slice(offset, end));
					offset = end;
					return;
				}
				controller.enqueue(suffix);
				controller.close();
				produced = true;
			},
			cancel() {
				stopped = true;
			},
		},
		{ highWaterMark: 0 },
	);
	try {
		const response = await read(url, {
			method: "POST",
			headers: {
				Authorization: `Bearer ${key}`,
				"content-type": `multipart/form-data; boundary=${boundary}`,
				"content-length": String(prefix.length + bytes.length + suffix.length),
			},
			body,
		});
		// Whether the body was complete when the response arrived, not after its JSON was read.
		const complete = produced;
		const interpret = provider === "poyo" ? interpretPoyoUpload : interpretToapisUpload;
		const outcome = interpret(response.status, await response.json(), file);
		// A success before the whole body was produced cannot describe the reviewed file.
		return complete || outcome.kind === "rejected" || outcome.kind === "unknown"
			? outcome
			: uncertainUpload;
	} catch {
		return uncertainUpload;
	} finally {
		// From here on, no chunk of this buffer reaches the body.
		stopped = true;
	}
}

export function sendFileEdit(
	provider: SeedreamProvider,
	key: string,
	request: ReviewedImageRequest,
	read: CheckFetch = filePost(request.url, 30_000),
) {
	const adapter = provider === "poyo" ? createPoyoImage(read) : createToapisImage(read);
	return adapter.submit(key, request);
}
