import { timingSafeEqual } from "node:crypto";
import { sql } from "drizzle-orm";
import { invalidFactor, staleProof } from "../services/owner/access-error";
import { sessionDigest, token } from "../services/owner/credentials";
import { checkStep, makeRecoverySet, recoveryDigest } from "../services/owner/factors";
import { idleMs, insertSession, lifetimeMs } from "./access-store";
import type { OwnerTransaction } from "./installation";
import type { Factor, Policy } from "./security-state";
import { deleteOwnerSessions } from "./session-retirement";

export async function requireSession(tx: OwnerTransaction, digest: string, now: number) {
	if (
		!(await tx.get(
			sql`SELECT 1 FROM session WHERE digest=${digest} AND owner_id=1 AND last_activity>${now - idleMs} AND last_activity<=${now} AND created_at>${now - lifetimeMs} AND created_at<=${now}`,
		))
	)
		throw staleProof();
}
export async function issueProof(
	tx: OwnerTransaction,
	state: Policy,
	origin: string,
	purpose: string,
	expires: number,
	session: string | null,
	candidate: string | null,
	method: "password" = "password",
) {
	const value = token();
	await tx.run(
		sql`INSERT INTO owner_proof VALUES(${sessionDigest(value)},1,${method},${state.primary_revision},${state.revision},${origin},${purpose},${session},${candidate},${expires})`,
	);
	return value;
}
export async function requireProof(
	tx: OwnerTransaction,
	state: Policy,
	value: string,
	origin: string,
	purpose: string,
	now: number,
	session: string | null,
) {
	const row = await tx.get<{ candidate: string | null; expires: number }>(
		sql`SELECT candidate,expires FROM owner_proof WHERE digest=${sessionDigest(value)} AND owner_id=1 AND method='password' AND primary_revision=${state.primary_revision} AND revision=${state.revision} AND origin=${origin} AND purpose=${purpose} AND expires>${now} AND session_digest IS ${session}`,
	);
	if (!row) throw staleProof();
	return row;
}
export function resumableCandidate(
	tx: OwnerTransaction,
	state: Policy,
	origin: string,
	session: string,
	now: number,
) {
	const action = state.enabled ? "replace" : "enable";
	return tx.get<{ digest: string; candidate: string }>(sql`SELECT digest,candidate FROM owner_proof
		WHERE owner_id=1 AND method='password' AND primary_revision=${state.primary_revision}
		AND revision=${state.revision} AND origin=${origin} AND purpose=${action}
		AND session_digest=${session} AND expires>${now} AND candidate IS NOT NULL`);
}
export async function consumeFactor(
	tx: OwnerTransaction,
	installation: string,
	factor: Factor,
	seed: Buffer,
	code: string,
	now: number,
) {
	const step = checkStep(seed, code, now, factor.used_step);
	if (
		step !== null &&
		(await tx.get(
			sql`UPDATE owner_factor SET used_step=${step} WHERE id=${factor.id} AND used_step<${step} RETURNING id`,
		))
	)
		return;
	const digest = recoveryDigest(installation, factor.set_id, code);
	if (digest) {
		const rows = await tx.all<{ digest: string }>(
			sql`SELECT digest FROM recovery_code WHERE set_id=${factor.set_id}`,
		);
		const found = rows.find((row) =>
			timingSafeEqual(Buffer.from(row.digest, "hex"), Buffer.from(digest, "hex")),
		);
		if (
			found &&
			(await tx.get(sql`DELETE FROM recovery_code WHERE digest=${found.digest} RETURNING digest`))
		) {
			await tx.run(sql`UPDATE owner_factor SET remaining=remaining-1 WHERE id=${factor.id}`);
			return;
		}
	}
	throw invalidFactor();
}
export async function rotateSecurity(
	tx: OwnerTransaction,
	installation: string,
	enabled: boolean,
	now: number,
) {
	await tx.run(sql`UPDATE owner_security SET enabled=${enabled ? 1 : 0},revision=revision+1`);
	await tx.run(sql`DELETE FROM owner_proof`);
	await deleteOwnerSessions(tx);
	await tx.run(sql`DELETE FROM recovery_code`);
	const session = token();
	await tx.run(insertSession(sessionDigest(session), now));
	const set = enabled ? makeRecoverySet(installation) : null;
	if (set) {
		await tx.run(sql`UPDATE owner_factor SET set_id=${set.id},remaining=10`);
		for (const digest of set.digests)
			await tx.run(sql`INSERT INTO recovery_code VALUES(${digest},${set.id})`);
	} else await tx.run(sql`DELETE FROM owner_factor`);
	return { session, codes: set?.codes ?? [] };
}

export async function replaceCandidateProof(
	tx: OwnerTransaction,
	state: Policy,
	origin: string,
	action: "enable" | "replace",
	digest: string,
	candidate: string,
	now: number,
) {
	await tx.run(sql`DELETE FROM owner_proof WHERE session_digest=${digest} OR expires<=${now}`);
	return issueProof(tx, state, origin, action, now + 300000, digest, candidate);
}
export const dropProof = (tx: OwnerTransaction, value: string) =>
	tx.run(sql`DELETE FROM owner_proof WHERE digest=${sessionDigest(value)}`);
export async function completeChallenge(tx: OwnerTransaction, value: string, now: number) {
	await dropProof(tx, value);
	const session = token();
	await tx.run(insertSession(sessionDigest(session), now));
	return session;
}
export async function activateFactor(
	tx: OwnerTransaction,
	installation: string,
	id: string,
	envelope: string,
	used: number,
	now: number,
) {
	await tx.run(sql`DELETE FROM owner_factor`);
	await tx.run(sql`INSERT INTO owner_factor VALUES(1,${id},${envelope},${used},'',0)`);
	return rotateSecurity(tx, installation, true, now);
}
