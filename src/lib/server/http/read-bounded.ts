/** A body exceeded the byte limit its reader was given. */
export class BodyLimitError extends Error {
	constructor() {
		super("The body exceeds its limit.");
		this.name = "BodyLimitError";
	}
}

/**
 * Read a byte stream up to `limit` bytes. `check` runs around every read and may
 * throw to stop it; an abort, including one before the call, cancels the stream
 * and rejects with its reason. Failure cancels the stream.
 */
export async function readBounded(
	stream: ReadableStream<Uint8Array>,
	limit: number,
	check?: () => void,
	signal?: AbortSignal,
) {
	const reader = stream.getReader();
	const cancel = () => {
		void reader.cancel().catch(() => {});
	};
	signal?.addEventListener("abort", cancel, { once: true });
	// An already-aborted signal never dispatches another abort event.
	if (signal?.aborted) cancel();
	const sink = new Bun.ArrayBufferSink();
	sink.start();
	let size = 0;
	try {
		for (;;) {
			signal?.throwIfAborted();
			check?.();
			const chunk = await reader.read();
			signal?.throwIfAborted();
			check?.();
			if (chunk.done) {
				const data = sink.end();
				return data instanceof ArrayBuffer
					? Buffer.from(data)
					: Buffer.from(data.buffer, data.byteOffset, data.byteLength);
			}
			if (!(chunk.value instanceof Uint8Array)) throw new TypeError("The body is not bytes.");
			size += chunk.value.byteLength;
			if (size > limit) throw new BodyLimitError();
			sink.write(chunk.value);
		}
	} catch (error) {
		cancel();
		throw error;
	} finally {
		signal?.removeEventListener("abort", cancel);
		reader.releaseLock();
	}
}
