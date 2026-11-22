import { createHash, timingSafeEqual } from "node:crypto";
import { accessStore } from "../../db/access-store";
import type { Installation } from "../../db/installation";

import { AccessError } from "./access-error";
import { createAuthenticator } from "./authenticator";
import { hashPassword, sessionDigest, token } from "./credentials";

export { AccessError } from "./access-error";

const invalidClaim = () => new AccessError("Check the claim token in your terminal.", 403);
const invalidLogin = () => new AccessError("Check your username and password.", 403);
const digest = (value: string) => createHash("sha256").update(value).digest();
export const rotationMs = 15 * 60000;
export function createOwnerAccess(
	installation: Installation,
	clock = Date.now,
	origin = "http://127.0.0.1",
) {
	const store = accessStore(installation);
	let claimDigest: Buffer | null = null;
	let expires = 0;
	function rotate() {
		const value = token();
		claimDigest = digest(value);
		expires = clock() + rotationMs;
		return value;
	}
	function current(value: string) {
		return claimDigest !== null && clock() < expires && timingSafeEqual(digest(value), claimDigest);
	}
	async function reserve(kind: "claim" | "signin") {
		const id = await store.reserve(kind, clock());
		if (!id) throw new AccessError("Too many attempts. Try again in five minutes.", 429);
		return id;
	}
	const security = createAuthenticator(installation, origin, clock, async (name, password) => {
		const attempt = await reserve("signin");
		const owner = await store.owner();
		if (
			!owner ||
			Buffer.byteLength(password) > 1024 ||
			!(await Bun.password.verify(password, owner.password_hash)) ||
			(name !== null && owner.username !== name.trim().normalize("NFC"))
		)
			throw invalidLogin();
		await store.release(attempt);
		return owner;
	});
	return {
		rotate,
		security,
		signIn: security.signIn,
		async claim(value: string, name: string, password: string) {
			const attempt = await reserve("claim");
			if (value.length > 128 || !current(value)) throw invalidClaim();
			await store.release(attempt);
			const username = name.trim().normalize("NFC");
			if (!username || Array.from(username).length > 64 || /\p{Cc}/u.test(username))
				throw new AccessError("Use a username of 1–64 characters without control characters.", 400);
			const hash = await hashPassword(password);
			const session = token();
			const won = await store.claim(username, hash, sessionDigest(session), clock(), () => {
				if (!current(value)) throw invalidClaim();
			});
			if (!won) throw invalidClaim();
			claimDigest = null;
			return session;
		},
		async session(value: string | undefined) {
			if (!value || !/^[\w-]{43}$/.test(value)) return null;
			return store.checkSession(sessionDigest(value), clock());
		},
		async signOut(value: string | undefined) {
			return !!value && !!(await store.revoke(sessionDigest(value)));
		},
	};
}
