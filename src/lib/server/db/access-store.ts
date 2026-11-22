import { sql } from "drizzle-orm";
import type { Installation } from "./installation";

export const idleMs = 7 * 86400000;
export const lifetimeMs = 30 * 86400000;

export function insertSession(digest: string, now: number) {
	return sql`INSERT INTO session (digest, owner_id, created_at, last_activity) VALUES (${digest}, 1, ${now}, ${now})`;
}

export function accessStore(installation: Installation) {
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
		claim(username: string, hash: string, digest: string, now: number, requireCurrent: () => void) {
			return use((db) =>
				db.transaction(
					async (tx) => {
						requireCurrent();
						const row = await tx.get(
							sql`UPDATE installation SET claimed=1 WHERE singleton=1 AND claimed=0 RETURNING singleton`,
						);
						if (!row) return false;
						await tx.run(
							sql`INSERT INTO owner (id, username, password_hash, created_at) VALUES(1,${username},${hash},${now})`,
						);
						await tx.run(insertSession(digest, now));
						requireCurrent();
						return true;
					},
					{ behavior: "immediate" },
				),
			);
		},
		checkSession(digest: string, now: number) {
			return use(async (db) => {
				await db.run(
					sql`DELETE FROM session WHERE last_activity <= ${now - idleMs} OR created_at <= ${now - lifetimeMs}`,
				);
				const row = await db.get<{ username: string }>(sql`UPDATE session SET last_activity=${now}
					WHERE digest=${digest} AND owner_id=1 AND EXISTS (SELECT 1 FROM owner_security WHERE singleton=1 AND recovery_required=0) AND created_at<=${now} AND last_activity<=${now}
					RETURNING (SELECT username FROM owner WHERE id=1) AS username`);
				return row?.username ?? null;
			});
		},
		revoke(digest: string) {
			return use((db) => db.get(sql`DELETE FROM session WHERE digest=${digest} RETURNING digest`));
		},
	};
}
