import { timingSafeEqual } from "node:crypto";
import { sql } from "drizzle-orm";
import { invalidFactor, staleProof } from "../services/owner/access-error";
import { sessionDigest, token } from "../services/owner/credentials";
import { checkStep, makeRecoverySet, recoveryDigest } from "../services/owner/factors";
import { idleMs, insertSession, lifetimeMs, newLogin, successor } from "./access-store";
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
/** Store a proof and return its secret value; only its digest is kept. */
export async function issueProof(
	tx: OwnerTransaction,
	state: Policy,
	origin: string,
	purpose: string,
	expires: number,
	session: string | null,
	candidate: string | null,
	{ key = null, method = "password" }: { key?: string | null; method?: "password" } = {},
) {
	const value = token();
	await tx.run(
		sql`INSERT INTO owner_proof (digest, owner_id, method, primary_revision, revision, origin, purpose, session_digest, candidate, expires, public_key)
		VALUES(${sessionDigest(value)},1,${method},${state.primary_revision},${state.revision},${origin},${purpose},${session},${candidate},${expires},${key})`,
	);
	return value;
}
/**
 * A live proof by digest. A pending sign-in names the browser key that may finish it
 * (`key`); Security proofs name the initiating session and no key.
 */
export async function requireProof(
	tx: OwnerTransaction,
	state: Policy,
	digest: string,
	origin: string,
	purpose: string,
	now: number,
	session: string | null,
	key: string | null = null,
) {
	const row = await tx.get<{ candidate: string | null; expires: number }>(
		sql`SELECT candidate,expires FROM owner_proof WHERE digest=${digest} AND owner_id=1 AND method='password' AND primary_revision=${state.primary_revision} AND revision=${state.revision} AND origin=${origin} AND purpose=${purpose} AND expires>${now} AND session_digest IS ${session} AND public_key IS ${key}`,
	);
	if (!row) throw staleProof();
	return row;
}
/** The candidate named by `requested`, only for its live session, action and revisions. */
export function resumableCandidate(
	tx: OwnerTransaction,
	state: Policy,
	origin: string,
	session: string,
	requested: string,
	now: number,
) {
	const action = state.enabled ? "replace" : "enable";
	return tx.get<{ digest: string; candidate: string }>(sql`SELECT digest,candidate FROM owner_proof
		WHERE digest=${requested} AND owner_id=1 AND method='password' AND primary_revision=${state.primary_revision}
		AND revision=${state.revision} AND origin=${origin} AND purpose=${action}
		AND session_digest=${session} AND expires>${now} AND candidate IS NOT NULL AND public_key IS NULL`);
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
/**
 * Commit a Security change: every session is replaced by the initiator's successor, which
 * keeps its browser key and login ID under a new session ID.
 */
export async function rotateSecurity(
	tx: OwnerTransaction,
	installation: string,
	enabled: boolean,
	now: number,
	initiating: string,
) {
	const initiator = await tx.get<{ key: string; loginId: string }>(
		sql`SELECT public_key AS key, login_id AS loginId FROM session WHERE digest=${initiating}`,
	);
	if (!initiator) throw staleProof();
	await tx.run(sql`UPDATE owner_security SET enabled=${enabled ? 1 : 0},revision=revision+1`);
	await tx.run(sql`DELETE FROM owner_proof`);
	await deleteOwnerSessions(tx);
	await tx.run(sql`DELETE FROM recovery_code`);
	const ids = successor(initiator.loginId);
	await tx.run(insertSession(initiator.key, ids, now));
	const set = enabled ? makeRecoverySet(installation) : null;
	if (set) {
		await tx.run(sql`UPDATE owner_factor SET set_id=${set.id},remaining=10`);
		for (const digest of set.digests)
			await tx.run(sql`INSERT INTO recovery_code VALUES(${digest},${set.id})`);
	} else await tx.run(sql`DELETE FROM owner_factor`);
	return { ...ids, codes: set?.codes ?? [] };
}

/** Replace this session's candidate; returns the new candidate's digest, which names it. */
export async function replaceCandidateProof(
	tx: OwnerTransaction,
	state: Policy,
	origin: string,
	action: "enable" | "replace",
	session: string,
	candidate: string,
	now: number,
) {
	await tx.run(sql`DELETE FROM owner_proof WHERE session_digest=${session} OR expires<=${now}`);
	return sessionDigest(
		await issueProof(tx, state, origin, action, now + 300000, session, candidate),
	);
}
const pendingSignIn = (digest: string, key: string) =>
	sql`digest=${digest} AND public_key=${key} AND purpose='signin' AND session_digest IS NULL`;
/** Cancel this key's pending sign-in. */
export const dropProof = (tx: OwnerTransaction, digest: string, key: string) =>
	tx.run(sql`DELETE FROM owner_proof WHERE ${pendingSignIn(digest, key)}`);
/** Spend this key's pending sign-in and replace the key's session with a new login. */
export async function completeChallenge(
	tx: OwnerTransaction,
	digest: string,
	key: string,
	now: number,
) {
	if (
		!(await tx.get(
			sql`DELETE FROM owner_proof WHERE ${pendingSignIn(digest, key)} RETURNING digest`,
		))
	)
		throw staleProof();
	await deleteOwnerSessions(tx, sql`public_key=${key}`);
	const ids = newLogin();
	await tx.run(insertSession(key, ids, now));
	return ids;
}
export async function activateFactor(
	tx: OwnerTransaction,
	installation: string,
	id: string,
	envelope: string,
	used: number,
	now: number,
	initiating: string,
) {
	await tx.run(sql`DELETE FROM owner_factor`);
	await tx.run(sql`INSERT INTO owner_factor VALUES(1,${id},${envelope},${used},'',0)`);
	return rotateSecurity(tx, installation, true, now, initiating);
}
