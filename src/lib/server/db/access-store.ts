import { randomBytes } from "node:crypto";
import { sql } from "drizzle-orm";
import type { Bearers } from "../services/owner/bearers";
import type { Installation, OwnerTransaction } from "./installation";
import { deleteOwnerSessions, ownerTransaction } from "./session-retirement";

export const idleMs = 7 * 86400000;
export const lifetimeMs = 30 * 86400000;

/** A session row's identity. The digest stays on the server; the IDs are not secret. */
export type SessionIds = { digest: string; sessionId: string; loginId: string };
/** A session as the browser receives it, with the bearer registered for it. */
export type Issued = SessionIds & { bearer: string };

const randomId = () => randomBytes(16).toString("base64url");
/** IDs for a new login: claim, sign-in and factor completion. */
export const newLogin = (): SessionIds => ({
	digest: randomBytes(32).toString("hex"),
	sessionId: randomId(),
	loginId: randomId(),
});
/** A Security change's successor keeps the login ID. */
export const successor = (loginId: string): SessionIds => ({ ...newLogin(), loginId });

export function insertSession(key: string, ids: SessionIds, now: number) {
	return sql`INSERT INTO session (digest, owner_id, public_key, session_id, login_id, created_at, last_activity)
		VALUES (${ids.digest}, 1, ${key}, ${ids.sessionId}, ${ids.loginId}, ${now}, ${now})`;
}
const live = (now: number) =>
	sql`owner_id=1 AND last_activity>${now - idleMs} AND last_activity<=${now} AND created_at>${now - lifetimeMs} AND created_at<=${now}`;
const unlocked = sql`EXISTS (SELECT 1 FROM owner_security WHERE singleton=1 AND recovery_required=0)`;
export const purgeExpired = (tx: OwnerTransaction, now: number) =>
	deleteOwnerSessions(
		tx,
		sql`last_activity <= ${now - idleMs} OR created_at <= ${now - lifetimeMs}`,
	);

export function accessStore(installation: Installation, bearers: Bearers) {
	const { use } = installation;
	return {
		reserve(kind: "claim" | "signin", now: number) {
			return use(async (db) => {
				await db.run(sql`DELETE FROM auth_attempt WHERE started <= ${now - 5 * 60000}`);
				const id = crypto.randomUUID();
				const row = await db.get(sql`INSERT INTO auth_attempt (id,kind,started)
					SELECT ${id}, ${kind}, ${now} WHERE
					(SELECT COUNT(*) FROM auth_attempt WHERE kind=${kind}) < ${kind === "claim" ? 5 : 10}
					RETURNING id`);
				return row ? id : null;
			});
		},
		release(id: string) {
			return use((db) => db.run(sql`DELETE FROM auth_attempt WHERE id=${id}`));
		},
		owner() {
			return use((db) =>
				db.get<{ username: string; password_hash: string }>(
					sql`SELECT username,password_hash FROM owner WHERE id=1`,
				),
			);
		},
		/** The winner's key gets the one session; its bearer is registered right after commit. */
		claim(username: string, hash: string, key: string, now: number, requireCurrent: () => void) {
			return use(async (db): Promise<Issued | null> => {
				const ids = newLogin();
				const won = await db.transaction(
					async (tx) => {
						requireCurrent();
						const row = await tx.get(
							sql`UPDATE installation SET claimed=1 WHERE singleton=1 AND claimed=0 RETURNING singleton`,
						);
						if (!row) return false;
						await tx.run(
							sql`INSERT INTO owner (id, username, password_hash, created_at) VALUES(1,${username},${hash},${now})`,
						);
						await tx.run(insertSession(key, ids, now));
						requireCurrent();
						return true;
					},
					{ behavior: "immediate" },
				);
				return won ? { ...ids, bearer: bearers.issue(ids.digest) } : null;
			});
		},
		/** A private request's session, marking its activity. */
		checkSession(digest: string, now: number) {
			return ownerTransaction(installation, async (db) => {
				await purgeExpired(db, now);
				return (
					(await db.get<{ username: string; sessionId: string; loginId: string }>(sql`UPDATE session
						SET last_activity=${now}
						WHERE digest=${digest} AND ${unlocked} AND ${live(now)}
						RETURNING (SELECT username FROM owner WHERE id=1) AS username, session_id AS sessionId, login_id AS loginId`)) ??
					null
				);
			});
		},
		/** The live session's IDs, read-only: last activity is unchanged. */
		sessionIds(digest: string, now: number) {
			return use(
				async (db) =>
					(await db.get<{ username: string; sessionId: string; loginId: string }>(
						sql`SELECT (SELECT username FROM owner WHERE id=1) AS username, session_id AS sessionId, login_id AS loginId
						FROM session WHERE digest=${digest} AND ${unlocked} AND ${live(now)}`,
					)) ?? null,
			);
		},
		/**
		 * A bearer for this key's live session, registered in the turn that read it. Retires
		 * `previous` when it belongs to the same session. Last activity is unchanged.
		 */
		resume(key: string, previous: unknown, now: number) {
			return use(async (db): Promise<Issued | null> => {
				const row = await db.get<{ digest: string; sessionId: string; loginId: string }>(
					sql`SELECT digest, session_id AS sessionId, login_id AS loginId FROM session
					WHERE public_key=${key} AND ${unlocked} AND ${live(now)}`,
				);
				if (!row) return null;
				bearers.retire(previous, row.digest);
				return { ...row, bearer: bearers.issue(row.digest) };
			});
		},
		/**
		 * End this key's session only when it carries `loginId`: a rotated successor ends,
		 * a later sign-in does not.
		 */
		revokeLogin(key: string, loginId: string, now: number) {
			return ownerTransaction(installation, async (tx) => {
				await purgeExpired(tx, now);
				if (await deleteOwnerSessions(tx, sql`public_key=${key} AND login_id=${loginId}`))
					return "revoked" as const;
				return (await tx.get(sql`SELECT 1 FROM session WHERE public_key=${key}`))
					? ("other" as const)
					: ("none" as const);
			});
		},
	};
}
