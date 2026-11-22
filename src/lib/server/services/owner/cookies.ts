import type { Cookies } from "@sveltejs/kit";
import { securityNoticeName } from "../../../shared/owner/session-notice";
import { sessionDigest } from "./credentials";
export function candidateReceipt(cookies: Cookies, name: string, session: string, origin: URL) {
	const prefix = `${name}_setup_${sessionDigest(`setup:${session}`)}_`;
	const options = {
		path: "/settings/security",
		httpOnly: true,
		sameSite: "lax" as const,
		secure: origin.protocol === "https:",
	};
	return {
		get: (digest: string) => cookies.get(prefix + digest),
		present: () => cookies.getAll().some((c) => c.name.startsWith(prefix)),
		save(proof: string) {
			// Reauthorization supersedes prior grants for this session. Delayed responses
			// only clear cookies present in their request and each grant has a unique name.
			for (const c of cookies.getAll()) {
				if (c.name.startsWith(prefix)) cookies.delete(c.name, options);
			}
			cookies.set(prefix + sessionDigest(proof), proof, { ...options, maxAge: 300 });
		},
		remove: (proof: string) => cookies.delete(prefix + sessionDigest(proof), options),
	};
}
export function pendingCredential(cookies: Cookies, name: string) {
	const selector = cookies.get(`${name}_pending`);
	if (!selector || !/^[a-f0-9]{64}$/.test(selector)) return "";
	const proof = cookies.get(`${name}_pending_${selector}`);
	return proof && sessionDigest(proof) === selector ? proof : "";
}
export function clearPendingCredential(cookies: Cookies, name: string, proof: string, origin: URL) {
	if (proof)
		cookies.delete(`${name}_pending_${sessionDigest(proof)}`, {
			path: "/sign-in",
			httpOnly: true,
			sameSite: "lax",
			secure: origin.protocol === "https:",
		});
}
export function setCredential(
	cookies: Cookies,
	name: string,
	value: string,
	origin: URL,
	pending = false,
) {
	const options = {
		path: pending ? "/sign-in" : "/",
		sameSite: "lax" as const,
		httpOnly: true,
		secure: origin.protocol === "https:",
		maxAge: pending ? 300 : 30 * 86400,
	};
	if (pending) {
		// The shared selector expires on its own. Only this grant's cookie carries its secret.
		const selector = sessionDigest(value);
		cookies.set(`${name}_pending`, selector, options);
		cookies.set(`${name}_pending_${selector}`, value, options);
	} else cookies.set(name, value, options);
}
export function securityNotice(origin: URL): Parameters<Cookies["set"]> {
	return [
		securityNoticeName(origin),
		crypto.randomUUID(),
		{
			path: "/",
			sameSite: "lax",
			httpOnly: false,
			secure: origin.protocol === "https:",
		},
	];
}
