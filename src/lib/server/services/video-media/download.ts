import { createHash } from "node:crypto";
import { open } from "node:fs/promises";
import { DeliveryUnavailable, direct, mediaResponse } from "../gallery/download";
import { ensure, videoByteLimit } from "./mp4";

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
	const primary = source.fallback ? AbortSignal.any([budget, AbortSignal.timeout(30_000)]) : budget;
	let signal = primary;
	let response: Response;
	try {
		response = await headers(source.url, transport, primary);
	} catch (error) {
		if (!(error instanceof DeliveryUnavailable) || !source.fallback) throw error;
		signal = budget;
		response = await headers(source.fallback, transport, budget);
	}
	const length = response.headers.get("content-length");
	const encoding = response.headers.get("content-encoding");
	const body = response.body;
	ensure(body);
	const reader = body.getReader();
	const abort = () => {
		void reader.cancel().catch(() => {});
	};
	signal.addEventListener("abort", abort, { once: true });
	try {
		ensure(
			response.status === 200 &&
				!response.headers.has("content-range") &&
				(!encoding || encoding.toLowerCase() === "identity"),
		);
		ensure(length === null || (/^\d+$/.test(length) && Number(length) <= videoByteLimit));
		const file = await open(path, "wx", 0o600);
		let size = 0;
		const digest = createHash("sha256");
		try {
			for (;;) {
				signal.throwIfAborted();
				const part = await reader.read();
				if (part.done) break;
				size += part.value.length;
				ensure(size <= videoByteLimit);
				digest.update(part.value);
				await file.writeFile(part.value);
			}
			signal.throwIfAborted();
			ensure(size > 0 && (length === null || size === Number(length)));
			await file.sync();
			return { size, digest: digest.digest("hex") };
		} finally {
			await file.close();
		}
	} finally {
		signal.removeEventListener("abort", abort);
		await reader.cancel();
	}
}
