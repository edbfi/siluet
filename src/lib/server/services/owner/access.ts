import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { accessStore } from "../../db/access-store";
import type { Installation } from "../../db/installation";

export class AccessError extends Error {
	constructor(
		message: string,
		readonly status: 400 | 403 | 429,
	) {
		super(message);
	}
}
const invalidClaim = () => new AccessError("Check the claim token in your terminal.", 403);
const invalidLogin = () => new AccessError("Check your username and password.", 403);
const token = () => randomBytes(32).toString("base64url");
const digest = (value: string) => createHash("sha256").update(value).digest();
const sessionDigest = (value: string) => digest(value).toString("hex");
export const rotationMs = 15 * 60000;
export function createOwnerAccess(installation: Installation, clock = Date.now) {
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
	return {
		rotate,
		async claim(value: string, name: string, password: string) {
			const attempt = await reserve("claim");
			if (value.length > 128 || !current(value)) throw invalidClaim();
			await store.release(attempt);
			const username = name.trim().normalize("NFC");
			if (!username || Array.from(username).length > 64 || /\p{Cc}/u.test(username))
				throw new AccessError("Use a username of 1–64 characters without control characters.", 400);
			if (Buffer.byteLength(password) > 1024 || Array.from(password).length < 15)
				throw new AccessError(
					"Use at least 15 characters and at most 1024 bytes for your password.",
					400,
				);
			const hash = await Bun.password.hash(password, { algorithm: "argon2id" });
			const session = token();
			const won = await store.claim(username, hash, sessionDigest(session), clock(), () => {
				if (!current(value)) throw invalidClaim();
			});
			if (!won) throw invalidClaim();
			claimDigest = null;
			return session;
		},
		async signIn(name: string, password: string) {
			const attempt = await reserve("signin");
			const owner = await store.owner();
			if (!owner || Buffer.byteLength(password) > 1024) throw invalidLogin();
			const matches = await Bun.password.verify(password, owner.password_hash);
			if (!matches || owner.username !== name.trim().normalize("NFC")) throw invalidLogin();
			const session = token();
			await store.newSession(sessionDigest(session), clock());
			await store.release(attempt);
			return session;
		},
		async session(value: string | undefined) {
			if (!value || !/^[\w-]{43}$/.test(value)) return null;
			return store.checkSession(sessionDigest(value), clock());
		},
		async signOut(value: string | undefined) {
			if (value) await store.revoke(sessionDigest(value));
		},
	};
}
