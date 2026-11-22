import { readBounded } from "../media-cleanup/preparation-bytes";

export async function ordinaryRequest(request: Request) {
	const limit = 512 * 1024;
	const declared = request.headers.get("content-length");
	if (declared !== null && (!/^\d+$/.test(declared) || Number(declared) > limit)) return null;
	if (!request.body) return request;
	try {
		const body = await readBounded(
			request.body,
			limit,
			() => request.signal.throwIfAborted(),
			request.signal,
		);
		return new Request(request.url, {
			method: request.method,
			headers: request.headers,
			body: new Uint8Array(body),
			signal: request.signal,
		});
	} catch {
		return null;
	}
}
