import type { FileHandle } from "node:fs/promises";
import { byteRange } from "../media/range";
export async function videoResponse(
	request: Request,
	url: URL,
	{ handle, size }: { handle: FileHandle; size: number },
) {
	const headers = new Headers({
		"Content-Type": "video/mp4",
		"Cache-Control": "private, no-store",
		"X-Content-Type-Options": "nosniff",
		"Cross-Origin-Resource-Policy": "same-origin",
		"Accept-Ranges": "bytes",
		"Content-Length": String(size),
		"Content-Disposition":
			url.searchParams.get("download") === "1"
				? 'attachment; filename="siluet-video.mp4"'
				: "inline",
	});
	if (request.method === "HEAD") {
		await handle.close();
		return new Response(null, { headers });
	}
	const range = request.headers.has("if-range")
		? null
		: byteRange(request.headers.get("range"), size);
	if (range === "unsatisfiable") {
		await handle.close();
		headers.set("Content-Range", `bytes */${size}`);
		headers.set("Content-Length", "0");
		return new Response(null, { status: 416, headers });
	}
	const [start, end] = range ?? [0, size - 1];
	if (range) {
		headers.set("Content-Range", `bytes ${start}-${end}/${size}`);
		headers.set("Content-Length", String(end - start + 1));
	}
	let offset = start;
	const stream = new ReadableStream<Uint8Array>({
		async pull(controller) {
			try {
				const bytes = new Uint8Array(Math.min(65536, end - offset + 1));
				const { bytesRead } = await handle.read(bytes, 0, bytes.length, offset);
				if (!bytesRead) throw new Error("Saved file unavailable.");
				controller.enqueue(bytes.subarray(0, bytesRead));
				offset += bytesRead;
				if (offset > end) {
					controller.close();
					await handle.close();
				}
			} catch {
				controller.error(new Error("Saved file unavailable."));
				await handle.close();
			}
		},
		async cancel() {
			await handle.close();
		},
	});
	return new Response(stream, { status: range ? 206 : 200, headers });
}
