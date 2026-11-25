import { mediaHeaders } from "../../http/security-headers";
import { byteRange } from "./range";
export type PrivateMediaLease = {
	handle: {
		read(
			bytes: Uint8Array,
			offset: number,
			length: number,
			position: number,
		): Promise<{ bytesRead: number }>;
		close(): Promise<void>;
	};
	size: number;
	mime: string;
	signal?: AbortSignal;
};
export async function privateMediaResponse(
	request: Request,
	{ handle, size, mime, signal: stageLifetime }: PrivateMediaLease,
	disposition = "inline",
) {
	const signal = stageLifetime ? AbortSignal.any([request.signal, stageLifetime]) : request.signal;
	if (signal.aborted) {
		await handle.close();
		return new Response(null, { status: 404, headers: { "Cache-Control": "private, no-store" } });
	}
	const headers = new Headers({
		"Content-Type": mime,
		// Staging accepts still JPEG and PNG only.
		...mediaHeaders("image"),
		"Accept-Ranges": "bytes",
		"Content-Length": String(size),
		"Content-Disposition": disposition,
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
	let closed: Promise<void> | undefined;
	let abort: () => void;
	function close() {
		signal.removeEventListener("abort", abort);
		closed ??= handle.close();
		return closed;
	}
	const stream = new ReadableStream<Uint8Array>({
		start(controller) {
			abort = () => {
				controller.error(new Error("Media stream closed."));
				void close().catch(() => {});
			};
			signal.addEventListener("abort", abort, { once: true });
		},
		async pull(controller) {
			try {
				const bytes = new Uint8Array(Math.min(65536, end - offset + 1));
				const { bytesRead } = await handle.read(bytes, 0, bytes.length, offset);
				if (closed) return;
				if (!bytesRead) throw new Error("Media unavailable.");
				controller.enqueue(bytes.subarray(0, bytesRead));
				offset += bytesRead;
				if (offset > end) {
					controller.close();
					await close();
				}
			} catch {
				if (!closed) controller.error(new Error("Media unavailable."));
				await close();
			}
		},
		async cancel() {
			await close();
		},
	});
	return new Response(stream, { status: range ? 206 : 200, headers });
}
