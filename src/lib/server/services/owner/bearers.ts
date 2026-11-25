import { createHash, randomBytes } from "node:crypto";

export const bearerMs = 10 * 60000;
const perSession = 64;
const digestOf = (bearer: string) => createHash("sha256").update(bearer).digest("hex");

/**
 * Short-lived bearers for live sessions, held in memory only. A bearer maps to its session's
 * internal digest; the session row stays the authority. Callers register a bearer in the same
 * `install.use` turn that committed or read its session, so a later retirement drops it.
 */
export function createBearers(monotonic = () => performance.now()) {
	const bearers = new Map<string, { session: string; expires: number }>();
	const bySession = new Map<string, string[]>();
	function drop(digest: string) {
		const entry = bearers.get(digest);
		if (!entry) return;
		bearers.delete(digest);
		const list = bySession.get(entry.session)?.filter((d) => d !== digest);
		if (list?.length) bySession.set(entry.session, list);
		else bySession.delete(entry.session);
	}
	return {
		issue(session: string) {
			const now = monotonic();
			const list: string[] = [];
			for (const digest of bySession.get(session) ?? []) {
				if ((bearers.get(digest)?.expires ?? 0) > now) list.push(digest);
				else bearers.delete(digest);
			}
			// The list keeps issue order, so the oldest bearer is evicted first.
			while (list.length >= perSession) bearers.delete(list.shift() as string);
			const bearer = randomBytes(32).toString("base64url");
			const digest = digestOf(bearer);
			bearers.set(digest, { session, expires: now + bearerMs });
			list.push(digest);
			bySession.set(session, list);
			return bearer;
		},
		/** The session digest of a live bearer. */
		session(bearer: string | null) {
			if (!bearer || !/^[\w-]{43}$/.test(bearer)) return null;
			const digest = digestOf(bearer);
			const entry = bearers.get(digest);
			if (!entry) return null;
			if (entry.expires > monotonic()) return entry.session;
			drop(digest);
			return null;
		},
		/** Retire a bearer, only when it belongs to `session`. */
		retire(bearer: unknown, session: string) {
			if (typeof bearer !== "string" || !/^[\w-]{43}$/.test(bearer)) return;
			const digest = digestOf(bearer);
			if (bearers.get(digest)?.session === session) drop(digest);
		},
		/** Drop every bearer of these sessions. */
		retireSessions(sessions: ReadonlySet<string>) {
			for (const session of sessions) {
				for (const digest of bySession.get(session) ?? []) bearers.delete(digest);
				bySession.delete(session);
			}
		},
	};
}
export type Bearers = ReturnType<typeof createBearers>;
