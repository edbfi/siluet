import { createHash, timingSafeEqual } from "node:crypto";
import { accessStore } from "../../db/access-store";
import type { Installation } from "../../db/installation";

import { AccessError } from "./access-error";
import { createAuthenticator } from "./authenticator";
import { type Bearers, createBearers } from "./bearers";
import { hashPassword, token } from "./credentials";

const invalidClaim = () => new AccessError("Check the claim token in your terminal.", 403);
const invalidLogin = () => new AccessError("Check your username and password.", 403);
const digest = (value: string) => createHash("sha256").update(value).digest();
export const rotationMs = 15 * 60000;
export function createOwnerAccess(
	installation: Installation,
	clock = Date.now,
	origin = "http://127.0.0.1",
	bearers: Bearers = createBearers(),
) {
	const store = accessStore(installation, bearers);
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
	const security = createAuthenticator(
		installation,
		origin,
		clock,
		async (name, password) => {
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
		},
		bearers,
	);
	return {
		rotate,
		security,
		signIn: security.signIn,
		/** Claim for the browser key `key`; its session is the only one. */
		async claim(value: string, name: string, password: string, key: string) {
			const attempt = await reserve("claim");
			if (value.length > 128 || !current(value)) throw invalidClaim();
			await store.release(attempt);
			const username = name.trim().normalize("NFC");
			if (!username || Array.from(username).length > 64 || /\p{Cc}/u.test(username))
				throw new AccessError("Use a username of 1–64 characters without control characters.", 400);
			const hash = await hashPassword(password);
			const won = await store.claim(username, hash, key, clock(), () => {
				if (!current(value)) throw invalidClaim();
			});
			if (!won) throw invalidClaim();
			claimDigest = null;
			return won;
		},
		/** The live session behind a bearer, marking its activity. */
		async session(bearer: string | null) {
			const session = bearers.session(bearer);
			if (!session) return null;
			const row = await store.checkSession(session, clock());
			return row && { ...row, digest: session };
		},
		/** The live session behind a bearer, read-only. */
		async peek(bearer: string | null) {
			const session = bearers.session(bearer);
			if (!session) return null;
			const row = await store.sessionIds(session, clock());
			return row && { ...row, digest: session };
		},
		/** The owner of a session that is still live, by its internal digest. */
		async live(digest: string) {
			return (await store.sessionIds(digest, clock()))?.username ?? null;
		},
		resume: (key: string, previous: unknown) => store.resume(key, previous, clock()),
		signOut: (key: string, loginId: string) => store.revokeLogin(key, loginId, clock()),
	};
}
export type OwnerAccess = ReturnType<typeof createOwnerAccess>;
/** The session the hook admitted a private request under. */
export type OwnerSession = NonNullable<Awaited<ReturnType<OwnerAccess["session"]>>>;
