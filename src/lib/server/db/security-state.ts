import { readdir } from "node:fs/promises";
import { sql } from "drizzle-orm";
import { AccessError, recoverMessage, staleProof } from "../services/owner/access-error";
import { cleanUnusedFactorKeys, factorIdPattern, KeyViolation, readFactorKey } from "./factor-key";
import type { Installation, OwnerTransaction } from "./installation";
import { openSeed } from "./seed-envelope";

export type Policy = {
	revision: number;
	primary_revision: number;
	enabled: number;
	recovery_required: number;
};
export type Factor = {
	id: string;
	envelope: string;
	used_step: number;
	set_id: string;
	remaining: number;
};
export async function policy(tx: OwnerTransaction) {
	const row = await tx.get<Policy>(sql`SELECT * FROM owner_security WHERE singleton=1`);
	if (!row || row.recovery_required) throw new AccessError(recoverMessage, 503);
	return row;
}
export async function currentPolicy(tx: OwnerTransaction, expected: Policy) {
	const current = await policy(tx);
	if (
		current.revision !== expected.revision ||
		current.primary_revision !== expected.primary_revision ||
		current.enabled !== expected.enabled
	)
		throw staleProof();
}
export function transact<T>(install: Installation, fn: (tx: OwnerTransaction) => Promise<T>) {
	return install.use((db) => db.transaction(fn, { behavior: "immediate" }));
}
const activeFactor = (tx: OwnerTransaction) =>
	tx.get<Factor>(sql`SELECT * FROM owner_factor WHERE singleton=1`);

async function inspectState(tx: OwnerTransaction) {
	const state = await policy(tx);
	const factor = await activeFactor(tx);
	const codes = await tx.all<{ set_id: string; digest: string }>(
		sql`SELECT * FROM recovery_code LIMIT 11`,
	);
	const consistent = state.enabled
		? factor &&
			factorIdPattern.test(factor.id) &&
			factorIdPattern.test(factor.set_id) &&
			codes.length === factor.remaining &&
			Number.isSafeInteger(factor.used_step) &&
			factor.used_step >= 0 &&
			codes.every((c) => c.set_id === factor.set_id && /^[0-9a-f]{64}$/.test(c.digest))
		: !factor && !codes.length;
	if (!consistent) {
		await tx.run(sql`UPDATE owner_security SET recovery_required=1 WHERE singleton=1`);
		return null;
	}
	return { state, factor };
}

type Acquisition = {
	revision: number;
	primaryRevision: number;
	id: string;
	envelope: string;
	reader: typeof readFactorKey;
	seed: Promise<Buffer>;
};
const inFlight = new WeakMap<Installation, Acquisition>();
function acquireSeed(
	install: Installation,
	state: Policy,
	factor: Factor,
	reader: typeof readFactorKey,
) {
	const prior = inFlight.get(install);
	if (
		prior &&
		prior.revision === state.revision &&
		prior.primaryRevision === state.primary_revision &&
		prior.id === factor.id &&
		prior.envelope === factor.envelope &&
		prior.reader === reader
	)
		return prior.seed;
	const seed = reader(install.directory, factor.id)
		.then((key) => openSeed(key, factor.envelope, install.id, factor.id))
		.finally(() => {
			if (inFlight.get(install)?.seed === seed) inFlight.delete(install);
		});
	inFlight.set(install, {
		revision: state.revision,
		primaryRevision: state.primary_revision,
		id: factor.id,
		envelope: factor.envelope,
		reader,
		seed,
	});
	return seed;
}
export async function checkedSecurity(install: Installation, readKey = readFactorKey) {
	const initial = await transact(install, inspectState);
	if (!initial) throw new AccessError(recoverMessage, 503);
	const { state, factor } = initial;
	if (!factor) return { state, factor: null, seed: null };

	// Only in-flight acquisition is shared. Each request independently rechecks the active reference.
	const seed = await acquireSeed(install, state, factor, readKey).catch((error: unknown) =>
		error instanceof KeyViolation
			? error
			: new AccessError("Authenticator storage is temporarily unavailable. Retry.", 503),
	);
	const verified = await transact(install, async (tx) => {
		await currentPolicy(tx, state);
		const current = await activeFactor(tx);
		if (current?.id !== factor.id || current.envelope !== factor.envelope) throw staleProof();
		if (seed instanceof AccessError) throw seed;
		if (seed instanceof KeyViolation) {
			await tx.run(sql`UPDATE owner_security SET recovery_required=1 WHERE singleton=1`);
			return null;
		}
		return { state, factor: current, seed };
	});
	if (!verified) throw new AccessError(recoverMessage, 503);
	return verified;
}

export async function cleanUnusedKeys(install: Installation) {
	// List first. A key already in this list cannot become active after the transaction:
	// publication and activation belong to one transaction and key paths are never reused.
	const names = await readdir(install.directory);
	const current = await transact(install, async (tx) => {
		const state = await policy(tx);
		const active = await activeFactor(tx);
		return Boolean(active) === Boolean(state.enabled) ? (active?.id ?? null) : undefined;
	});
	if (current !== undefined) await cleanUnusedFactorKeys(install.directory, current, names);
}
