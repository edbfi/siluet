import { mediaHeaders } from "../../http/security-headers";

/** A saved image read into memory under one of the route's read permits. */
export type OpenedImage = {
	mime: "image/png" | "image/jpeg" | "image/webp";
	size: number;
	/** The verified bytes; null once the response finished with them. */
	bytes: Buffer | null;
	/** Frees the read permit. Calling it again does nothing. */
	release: () => void;
};

/** A response body that nobody reads for this long errors, freeing its permit and buffer. */
export const imageIdleMs = 60_000;
const sliceBytes = 65_536;

/**
 * The saved image's headers with its exact length under `length`. Bun 1.4.5 drops a set
 * `Content-Length` from a JavaScript stream body, so a GET declares the verified length as
 * `X-Siluet-Length`, which the tab reserves (private-media.ts); a HEAD keeps `Content-Length`.
 */
const headers = (
	image: Pick<OpenedImage, "mime" | "size">,
	url: URL,
	filename: string,
	length: "content-length" | "x-siluet-length",
) => ({
	...mediaHeaders("image"),
	"content-type": image.mime,
	[length]: String(image.size),
	"content-disposition":
		url.searchParams.get("download") === "1" ? `attachment; filename="${filename}"` : "inline",
});

/** HEAD: the saved image's headers, from its row and file size alone. */
export function imageHead(image: Pick<OpenedImage, "mime" | "size">, url: URL, filename: string) {
	return new Response(null, { headers: headers(image, url, filename, "content-length") });
}

/**
 * Stream an opened image in 64 KiB slices as the client pulls them, so a paused client applies
 * backpressure. Finishing, a cancel (Bun's idle timeout on a stalled socket) or 60 s without a
 * pull release the permit and drop the buffer. A default stream, not a byte stream, which would
 * transfer the shared buffer away.
 */
export function imageResponse(image: OpenedImage, url: URL, filename: string) {
	let offset = 0;
	let timer: ReturnType<typeof setTimeout> | undefined;
	const finish = () => {
		clearTimeout(timer);
		image.bytes = null;
		image.release();
	};
	const arm = (controller: ReadableStreamDefaultController<Uint8Array>) => {
		clearTimeout(timer);
		timer = setTimeout(() => {
			controller.error(new Error("The saved image was not read in time."));
			finish();
		}, imageIdleMs);
	};
	const body = new ReadableStream<Uint8Array>({
		start: arm,
		pull(controller) {
			const bytes = image.bytes;
			if (!bytes || offset >= bytes.length) {
				controller.close();
				finish();
				return;
			}
			const end = Math.min(offset + sliceBytes, bytes.length);
			controller.enqueue(bytes.subarray(offset, end));
			offset = end;
			arm(controller);
		},
		cancel: finish,
	});
	return new Response(body, { headers: headers(image, url, filename, "x-siluet-length") });
}
