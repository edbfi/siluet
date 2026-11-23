import { createHash } from "node:crypto";
import { open } from "node:fs/promises";
import { DeliveryUnavailable, direct, mediaResponse } from "../gallery/download";
import { check } from "./errors";
import { videoByteLimit } from "./limits";

// A refused transfer is a failed download; only a file over the size limit is unsupported.
function ensure(condition: unknown): asserts condition {
	if (!condition) throw new Error("The video transfer was refused.");
}

export type VideoDelivery = { url: string; fallback: string | null };
async function headers(url: string, transport: typeof direct, signal: AbortSignal) {
	const timeout = Promise.withResolvers<never>();
	const abort = () => timeout.reject(new DeliveryUnavailable());
	signal.addEventListener("abort", abort, { once: true });
	try {
		signal.throwIfAborted();
		const response = await Promise.race([mediaResponse(url, transport, signal), timeout.promise]);
		if (!response.ok) {
			void response.body?.cancel();
			throw new DeliveryUnavailable();
		}
		return response;
	} finally {
		signal.removeEventListener("abort", abort);
	}
}
export async function downloadVideo(source: VideoDelivery, path: string, transport = direct) {
	const budget = AbortSignal.timeout(60_000);
	let response: Response;
	if (source.fallback) {
		const deadline = AbortSignal.timeout(30_000);
		const headerController = new AbortController();
		const stop = () => headerController.abort();
		deadline.addEventListener("abort", stop, { once: true });
		try {
			response = await headers(
				source.url,
				transport,
				AbortSignal.any([budget, headerController.signal]),
			);
		} catch (error) {
			if (!(error instanceof DeliveryUnavailable)) throw error;
			budget.throwIfAborted();
			response = await headers(source.fallback, transport, budget);
		} finally {
			deadline.removeEventListener("abort", stop);
		}
	} else {
		response = await headers(source.url, transport, budget);
	}
	const length = response.headers.get("content-length");
	const encoding = response.headers.get("content-encoding");
	const body = response.body;
	ensure(body);
	const reader = body.getReader();
	const abort = () => {
		void reader.cancel().catch(() => {});
	};
	budget.addEventListener("abort", abort, { once: true });
	try {
		ensure(
			response.status === 200 &&
				!response.headers.has("content-range") &&
				(!encoding || encoding.toLowerCase() === "identity"),
		);
		ensure(length === null || /^\d+$/.test(length));
		check(length === null || Number(length) <= videoByteLimit, "file size");
		const file = await open(path, "wx", 0o600);
		let size = 0;
		const digest = createHash("sha256");
		try {
			for (;;) {
				budget.throwIfAborted();
				const part = await reader.read();
				if (part.done) break;
				size += part.value.length;
				check(size <= videoByteLimit, "file size");
				digest.update(part.value);
				await file.writeFile(part.value);
			}
			budget.throwIfAborted();
			ensure(size > 0 && (length === null || size === Number(length)));
			await file.sync();
			return { size, digest: digest.digest("hex") };
		} finally {
			await file.close();
		}
	} finally {
		budget.removeEventListener("abort", abort);
		await reader.cancel();
	}
}
