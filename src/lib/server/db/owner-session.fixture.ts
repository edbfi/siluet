import { sql } from "drizzle-orm";
import { insertSession, newLogin } from "./access-store";
import type { Installation } from "./installation";
import { deleteOwnerSessions, ownerTransaction } from "./session-retirement";

/** Claim the installation for `username` with one session whose internal digest is `digest`. */
export function claimOwner(install: Installation, username: string, digest: string, now: number) {
	return install.use((db) =>
		db.transaction(async (tx) => {
			await tx.run(sql`UPDATE installation SET claimed=1 WHERE singleton=1`);
			await tx.run(
				sql`INSERT INTO owner (id, username, password_hash, created_at) VALUES(1,${username},'unused',${now})`,
			);
			await tx.run(insertSession(`key-${digest}`, { ...newLogin(), digest }, now));
		}),
	);
}
/** Another session for the same owner. */
export const addSession = (install: Installation, digest: string, now: number) =>
	install.use((db) => db.run(insertSession(`key-${digest}`, { ...newLogin(), digest }, now)));
/** Revoke one session, retiring it as sign-out does. */
export const revokeSession = (install: Installation, digest: string) =>
	ownerTransaction(install, (tx) => deleteOwnerSessions(tx, sql`digest=${digest}`));
