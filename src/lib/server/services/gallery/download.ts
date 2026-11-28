import { lookup } from "node:dns/promises";
import { isIP } from "node:net";
import { galleryImageLimits } from "../../../shared/gallery/limits";
import { parseReferenceUrl } from "../../../shared/image-studio/references";

/** The largest image Gallery accepts, also the browser's limit for reading one back. */
export const encodedLimit = galleryImageLimits.bytes;
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
	try {
		return length === null
			? await readUndeclared(reader)
			: await readDeclared(reader, Number(length));
	} finally {
		await reader.cancel();
	}
}

type ByteReader = ReadableStreamDefaultReader<Uint8Array>;

/** A declared length sizes the buffer once; the body must fill it exactly. */
async function readDeclared(reader: ByteReader, declared: number) {
	const buffer = Buffer.allocUnsafe(declared);
	let total = 0;
	while (true) {
		const chunk = await reader.read();
		if (chunk.done) break;
		if (total + chunk.value.byteLength > declared) throw invalid();
		buffer.set(chunk.value, total);
		total += chunk.value.byteLength;
	}
	if (total === 0 || total !== declared) throw invalid();
	return buffer;
}

/** Only an undeclared body grows a sink, up to the encoded limit. */
async function readUndeclared(reader: ByteReader) {
	const sink = new Bun.ArrayBufferSink();
	sink.start({});
	let total = 0;
	while (true) {
		const chunk = await reader.read();
		if (chunk.done) break;
		total += chunk.value.byteLength;
		if (total > encodedLimit) throw invalid();
		sink.write(chunk.value);
	}
	if (total === 0) throw invalid();
	const bytes = sink.end();
	return bytes instanceof ArrayBuffer
		? Buffer.from(bytes)
		: Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
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

/**
 * An image transfer's two deadlines, as video's: headers within 30 s, so a dead host fails fast,
 * and the whole body within 75 s, which keeps today's floor of 32 MiB in 30 s at 80 MiB.
 */
export const imageDeadlines = { headersMs: 30_000, totalMs: 75_000 };

/** Download one image within `deadlines`. A caller `signal` (shutdown) aborts the transfer. */
export async function downloadImage(
	source: string,
	transport = direct,
	signal?: AbortSignal,
	deadlines = imageDeadlines,
) {
	const controller = new AbortController();
	const deadline = Promise.withResolvers<never>();
	const stop = (error: Error) => {
		controller.abort();
		deadline.reject(error);
	};
	const total = setTimeout(() => stop(invalid()), deadlines.totalMs);
	const headers = setTimeout(() => stop(invalid()), deadlines.headersMs);
	const cancel = () => stop(signal?.reason ?? new Error("The image transfer was aborted."));
	signal?.addEventListener("abort", cancel, { once: true });
	try {
		signal?.throwIfAborted();
		return await Promise.race([
			mediaResponse(source, transport, controller.signal).then((response) => {
				clearTimeout(headers);
				return readImage(response);
			}),
			deadline.promise,
		]);
	} finally {
		clearTimeout(headers);
		clearTimeout(total);
		signal?.removeEventListener("abort", cancel);
	}
}
