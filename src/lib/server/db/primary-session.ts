import { sql } from "drizzle-orm";
import { staleProof } from "../services/owner/access-error";
import { insertSession, newLogin } from "./access-store";
import type { OwnerTransaction } from "./installation";
import { issueProof } from "./owner-proofs";
import { currentPolicy, type Policy } from "./security-state";
import { deleteOwnerSessions } from "./session-retirement";

// Only a server-side primary verifier supplies this evidence. Its configuration
// check runs again inside the transaction where the session or challenge is issued.
export type VerifiedPrimary = {
	owner: 1;
	method: "password";
	policy: Policy;
	requireConfiguration: (tx: OwnerTransaction) => Promise<void>;
};
export async function requirePrimary(tx: OwnerTransaction, primary: VerifiedPrimary) {
	if (primary.owner !== 1) throw staleProof();
	await currentPolicy(tx, primary.policy);
	await primary.requireConfiguration(tx);
}
/**
 * Finish a verified primary sign-in for one browser key. Without MFA the key's session is
 * replaced; with MFA only the key's earlier pending sign-in is, and nothing is revoked yet.
 */
export async function issueAfterPrimary(
	tx: OwnerTransaction,
	primary: VerifiedPrimary,
	origin: string,
	key: string,
	elapsed: number,
	time: number,
) {
	await requirePrimary(tx, primary);
	await tx.run(
		sql`DELETE FROM owner_proof WHERE (public_key=${key} AND purpose='signin' AND session_digest IS NULL) OR expires<=${elapsed}`,
	);
	if (primary.policy.enabled)
		return {
			kind: "pending" as const,
			token: await issueProof(tx, primary.policy, origin, "signin", elapsed + 300000, null, null, {
				key,
				method: primary.method,
			}),
		};
	await deleteOwnerSessions(tx, sql`public_key=${key}`);
	const ids = newLogin();
	await tx.run(insertSession(key, ids, time));
	return { kind: "session" as const, ...ids };
}
export function verifiedPassword(
	state: Policy,
	owner: { username: string; password_hash: string },
): VerifiedPrimary {
	return {
		owner: 1,
		method: "password",
		policy: state,
		async requireConfiguration(tx) {
			if (
				!(await tx.get(
					sql`SELECT 1 FROM owner WHERE id=1 AND username=${owner.username} AND password_hash=${owner.password_hash}`,
				))
			)
				throw staleProof();
		},
	};
}
