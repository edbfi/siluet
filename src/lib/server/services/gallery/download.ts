import { lookup } from "node:dns/promises";
import { isIP } from "node:net";
import { parseReferenceUrl } from "../../../shared/image-studio/references";

const encodedLimit = 32 * 1024 * 1024;
const invalid = () => new Error("Could not retrieve the image.");

export type Transport = {
	resolve: (hostname: string) => Promise<string>;
	request: (url: URL, init: BunFetchRequestInit) => Promise<Response>;
};

export const direct: Transport = {
	resolve: async (hostname) => (await lookup(hostname)).address,
	request: (url, init) => fetch(url, init),
};

async function readImage(response: Response) {
	const length = response.headers.get("content-length");
	const encoding = response.headers.get("content-encoding");
	if (
		response.status !== 200 ||
		(encoding && encoding.toLowerCase() !== "identity") ||
		(length !== null && (!/^\d+$/.test(length) || Number(length) > encodedLimit)) ||
		!response.body
	) {
		await response.body?.cancel();
		throw invalid();
	}
	const reader = response.body.getReader();
	const sink = new Bun.ArrayBufferSink();
	sink.start();
	let total = 0;
	try {
		while (true) {
			const chunk = await reader.read();
			if (chunk.done) break;
			total += chunk.value.byteLength;
			if (total > encodedLimit) throw invalid();
			sink.write(chunk.value);
		}
		if (total === 0 || (length !== null && Number(length) !== total)) throw invalid();
		const bytes = sink.end();
		return bytes instanceof ArrayBuffer
			? Buffer.from(bytes)
			: Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
	} finally {
		await reader.cancel();
	}
}

export class DeliveryUnavailable extends Error {}

export async function mediaResponse(source: string, transport: Transport, signal: AbortSignal) {
	let url = new URL(source);
	for (let redirects = 0; redirects <= 5; redirects++) {
		if (url.protocol !== "https:" || !parseReferenceUrl(url.href)) throw invalid();
		const hostname = url.hostname.replace(/^\[|\]$/g, "");
		const address = isIP(hostname)
			? hostname
			: await transport.resolve(hostname).catch(() => {
					throw new DeliveryUnavailable();
				});
		const family = isIP(address);
		const literal = family === 6 ? `[${address}]` : address;
		if (!family || !parseReferenceUrl(`https://${literal}/`)) throw invalid();
		signal.throwIfAborted();
		// Bun dials the numeric URL and uses serverName for SNI and certificate checks.
		// https://bun.com/docs/runtime/networking/fetch#connecting-to-a-specific-address
		const target = new URL(url);
		target.hostname = literal;
		const response = await transport
			.request(target, {
				redirect: "manual",
				credentials: "omit",
				keepalive: false,
				proxy: false,
				decompress: false,
				headers: { host: url.host, "accept-encoding": "identity" },
				tls: { serverName: hostname, rejectUnauthorized: true },
				signal,
			})
			.catch(() => {
				throw new DeliveryUnavailable();
			});
		if (![301, 302, 303, 307, 308].includes(response.status)) {
			if (response.status >= 300 && response.status < 400) {
				void response.body?.cancel().catch(() => {});
				throw invalid();
			}
			return response;
		}
		void response.body?.cancel().catch(() => {});
		const location = response.headers.get("location");
		if (!location) throw invalid();
		url = new URL(location, url);
	}
	throw invalid();
}

/** Download one image within 30 seconds. A caller `signal` (shutdown) aborts the transfer. */
export async function downloadImage(source: string, transport = direct, signal?: AbortSignal) {
	const controller = new AbortController();
	const deadline = Promise.withResolvers<never>();
	const stop = (error: Error) => {
		controller.abort();
		deadline.reject(error);
	};
	const timer = setTimeout(() => stop(invalid()), 30_000);
	const cancel = () => stop(signal?.reason ?? new Error("The image transfer was aborted."));
	signal?.addEventListener("abort", cancel, { once: true });
	try {
		signal?.throwIfAborted();
		return await Promise.race([
			mediaResponse(source, transport, controller.signal).then(readImage),
			deadline.promise,
		]);
	} finally {
		clearTimeout(timer);
		signal?.removeEventListener("abort", cancel);
	}
}
