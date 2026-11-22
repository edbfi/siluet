import { localImageLimitRefusal, maxLocalImageBytes } from "../../../shared/media-staging/limits";

// Both qualified cleaners impose a lower encoded limit than the 32,000,000-byte transport.
export const maxPreparationBytes = maxLocalImageBytes;
export const maxRefusalBytes = 512;

export function mediaMime(bytes: Uint8Array) {
	if (bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255) return "image/jpeg";
	if ([137, 80, 78, 71, 13, 10, 26, 10].every((byte, i) => bytes[i] === byte)) return "image/png";
}

const failures = {
	format: ["Unsupported image format.", "Choose a single-frame SDR JPEG or PNG."],
	limit: localImageLimitRefusal,
	busy: ["Another file is being prepared.", "Retry after the current preparation finishes."],
	cancelled: ["Image preparation was cancelled.", "Select the file again to retry."],
	timeout: ["Image preparation timed out.", "Choose a smaller SDR JPEG or PNG and try again."],
	failed: ["The image could not be prepared.", "Export a fresh SDR JPEG or PNG and try again."],
} as const;

export const preparationRefusals = Object.values(failures);

export class PreparationError extends Error {
	readonly advice: string;
	constructor(
		readonly code: keyof typeof failures | "declined",
		[reason, advice]: readonly [string, string],
	) {
		super(reason);
		this.name = "PreparationError";
		this.advice = advice;
	}
}

export function failure(code: keyof typeof failures) {
	return new PreparationError(code, failures[code]);
}

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
	const sink = new Bun.ArrayBufferSink();
	sink.start();
	let size = 0;
	try {
		for (;;) {
			check?.();
			const chunk = await reader.read();
			check?.();
			if (chunk.done) {
				const data = sink.end();
				return data instanceof ArrayBuffer
					? Buffer.from(data)
					: Buffer.from(data.buffer, data.byteOffset, data.byteLength);
			}
			if (!(chunk.value instanceof Uint8Array)) throw failure("failed");
			size += chunk.value.byteLength;
			if (size > limit) throw failure("limit");
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
