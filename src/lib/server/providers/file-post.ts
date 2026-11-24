import { isIP } from "node:net";
import { parseReferenceUrl } from "../../shared/image-studio/references";
import type { CheckFetch } from "./connection-check";

const failed = () => new Error("Provider transfer unavailable.");
const limit = 64 * 1024;
type Resolve = (host: string) => Promise<string | undefined>;
type Send = (url: URL, init: BunFetchRequestInit) => Promise<Response>;
const lookup: Resolve = async (host) => (await Bun.dns.lookup(host))[0]?.address;
const transport: Send = (url, init) => fetch(url, init);

type DestinationStop = { reason: "destination" };
type Pin = { expired: () => boolean; sent: boolean; permitted?: () => boolean };
const pins = new WeakMap<CheckFetch, Pin>();

// Keep a positive pre-transport refusal distinguishable from a lost response.
export function guardFilePost<Stop extends { reason: string } = never>(
	read: CheckFetch,
	validate?: () => Stop | undefined,
) {
	const pin = pins.get(read);
	let refused: Stop | DestinationStop | undefined;
	let invoked = false;
	function check() {
		if (pin?.sent || (!pin && invoked)) return undefined;
		refused ??= validate?.() ?? (pin?.expired() ? { reason: "destination" } : undefined);
		return refused;
	}
	if (pin) pin.permitted = () => !check();
	const guarded: CheckFetch = (url, init) => {
		if (check()) return Promise.reject(failed());
		invoked = true;
		return read(url, init);
	};
	return { read: guarded, check };
}

export function filePost(
	endpoint: string,
	timeout: number,
	resolve = lookup,
	send = transport,
): CheckFetch {
	return async (url, init) => {
		if (url !== endpoint || init.method !== "POST") throw failed();
		const pinned = await pinFilePost(endpoint, timeout, resolve, send);
		return pinned(url, init);
	};
}

// https://bun.com/docs/runtime/networking/fetch#connecting-to-a-specific-address
export async function pinFilePost(
	endpoint: string,
	timeout: number,
	resolve = lookup,
	send = transport,
	monotonic = () => performance.now(),
): Promise<CheckFetch> {
	const target = new URL(endpoint);
	if (target.protocol !== "https:" || target.port || !parseReferenceUrl(endpoint)) throw failed();
	const hostname = target.hostname;
	const deadline = Promise.withResolvers<never>();
	const until = monotonic() + timeout;
	const timer = setTimeout(() => deadline.reject(failed()), timeout);
	try {
		const address = await Promise.race([resolve(hostname), deadline.promise]);
		const family = address && isIP(address);
		const literal = family === 6 ? `[${address}]` : address;
		if (!literal || !family || !parseReferenceUrl(`https://${literal}/`)) throw failed();
		target.hostname = literal;
	} finally {
		clearTimeout(timer);
	}
	const pin: Pin = { expired: () => monotonic() >= until, sent: false };
	let used = false;
	const pinned: CheckFetch = async (url, init) => {
		if (used || url !== endpoint || init.method !== "POST" || monotonic() >= until) throw failed();
		used = true;
		const controller = new AbortController();
		let throttled: ResponseInit | undefined;
		const deadline = Promise.withResolvers<never>();
		const timer = setTimeout(() => {
			controller.abort();
			deadline.reject(failed());
		}, until - monotonic());
		async function transfer() {
			const headers = new Headers(init.headers);
			headers.set("host", hostname);
			headers.set("accept-encoding", "identity");
			if (pin.expired() || pin.permitted?.() === false) throw failed();
			pin.sent = true;
			const response = await send(target, {
				method: "POST",
				headers,
				body: init.body,
				credentials: "omit",
				keepalive: false,
				proxy: false,
				redirect: "error",
				decompress: false,
				tls: { serverName: hostname, rejectUnauthorized: true },
				signal: controller.signal,
			});
			const metadata = new Headers();
			for (const name of [
				"retry-after",
				"x-ratelimit-category",
				"x-ratelimit-remaining",
				"x-ratelimit-reset",
			]) {
				const value = response.headers.get(name);
				if (value !== null) metadata.set(name, value);
			}
			const result = { status: response.status, headers: metadata };
			if (response.status === 429 || response.status === 503) throttled = result;
			const reader = response.body?.getReader();
			const cancel = () => {
				void reader?.cancel().catch(() => {});
			};
			controller.signal.addEventListener("abort", cancel, { once: true });
			try {
				if (
					(response.status >= 300 && response.status < 400) ||
					Number(response.headers.get("content-length")) > limit
				)
					throw failed();
				if (!reader) return new Response(null, result);
				const sink = new Bun.ArrayBufferSink();
				sink.start();
				let size = 0;
				for (;;) {
					const chunk = await reader.read();
					if (chunk.done) break;
					size += chunk.value.length;
					if (size > limit) throw failed();
					sink.write(chunk.value);
				}
				controller.signal.throwIfAborted();
				return new Response(sink.end(), result);
			} finally {
				controller.signal.removeEventListener("abort", cancel);
				cancel();
			}
		}
		try {
			return await Promise.race([transfer(), deadline.promise]);
		} catch {
			// A failed body cannot erase an observed limiter response.
			if (throttled) return new Response(null, throttled);
			throw failed();
		} finally {
			clearTimeout(timer);
			controller.abort();
		}
	};
	pins.set(pinned, pin);
	return pinned;
}
