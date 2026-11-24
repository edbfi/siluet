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

export async function uploadFile(
	provider: SeedreamProvider,
	key: string,
	file: StageDescriptor,
	bytes: Uint8Array<ArrayBuffer>,
	read: CheckFetch = filePost(fileUploadRoutes[provider], 60_000),
): Promise<UploadOutcome> {
	const url = fileUploadRoutes[provider];
	// Stream the exclusively owned, digest-checked buffer between two small MIME boundaries.
	const boundary = `siluet-${crypto.randomUUID()}`;
	const prefix = Buffer.from(
		`--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${neutralFilename(file.mime)}"\r\nContent-Type: ${file.mime}\r\n\r\n`,
	);
	const suffix = Buffer.from(`\r\n--${boundary}--\r\n`);
	const body = new ReadableStream<Uint8Array>({
		start(controller) {
			controller.enqueue(prefix);
			controller.enqueue(bytes);
			controller.enqueue(suffix);
			controller.close();
		},
	});
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
		const interpret = provider === "poyo" ? interpretPoyoUpload : interpretToapisUpload;
		return interpret(response.status, await response.json(), file);
	} catch {
		return uncertainUpload;
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
