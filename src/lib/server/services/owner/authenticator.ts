import { randomBytes } from "node:crypto";
import { openFactorBudget } from "../../db/factor-budget";
import { publishFactorKey, retireFactorKey } from "../../db/factor-key";
import type { Installation, OwnerTransaction } from "../../db/installation";
import {
	activateFactor,
	completeChallenge,
	consumeFactor,
	dropProof,
	replaceCandidateProof,
	requireProof,
	requireSession,
	resumableCandidate,
	rotateSecurity,
} from "../../db/owner-proofs";
import { issueAfterPrimary, requirePrimary, verifiedPassword } from "../../db/primary-session";
import { checkedSecurity, currentPolicy, transact } from "../../db/security-state";
import { openSeed, sealSeed } from "../../db/seed-envelope";
import {
	AccessError,
	CandidateRetry,
	invalidFactor,
	RetryableFactorError,
	recoverMessage,
	staleProof,
} from "./access-error";
import { sessionDigest } from "./credentials";
import { checkStep, setupMaterial } from "./factors";

export type Change = "enable" | "replace" | "disable" | "regenerate";
type Primary = { username: string; password_hash: string };
type Validate = (tx: OwnerTransaction) => Promise<void>;
export function createAuthenticator(
	install: Installation,
	origin: string,
	clock: () => number,
	verify: (name: string | null, password: string) => Promise<Primary>,
	monotonic = () => performance.now(),
) {
	let budgetPromise: ReturnType<typeof openFactorBudget> | undefined;
	const budget = () => (budgetPromise ??= openFactorBudget(install, monotonic));
	const candidateKey = randomBytes(32);
	const snapshot = () => checkedSecurity(install);
	async function attempt<T>(
		validate: Validate,
		reset: boolean,
		work: (tx: OwnerTransaction) => Promise<T>,
	) {
		const limits = await budget();
		const id = await limits.reserve(validate);
		try {
			return await transact(install, async (tx) => {
				await validate(tx);
				const result = await work(tx);
				await limits.success(tx, id, reset);
				return result;
			});
		} catch (e) {
			if ((await limits.failure(id)) >= 100) throw new AccessError(recoverMessage, 429);
			throw e;
		}
	}
	return {
		initialize: budget,
		snapshot,
		async signIn(name: string, password: string, previous = "") {
			const limits = await budget();
			const { state } = await snapshot();
			const primary = verifiedPassword(state, await verify(name, password));
			return transact(install, (tx) =>
				issueAfterPrimary(tx, primary, origin, previous, limits.now(), clock()),
			);
		},
		async pending(value: string) {
			const limits = await budget();
			const { state } = await snapshot();
			try {
				await transact(install, (tx) =>
					requireProof(tx, state, value, origin, "signin", limits.now(), null),
				);
				return true;
			} catch (e) {
				if (e instanceof AccessError && e.status === 403) return false;
				throw e;
			}
		},
		async cancel(value: string) {
			await transact(install, async (tx) => {
				await dropProof(tx, value);
			});
		},
		async complete(value: string, code: string) {
			const limits = await budget();
			const { state, seed, factor } = await snapshot();
			if (!factor || !seed) throw staleProof();
			const validate = async (tx: OwnerTransaction) => {
				await currentPolicy(tx, state);
				await requireProof(tx, state, value, origin, "signin", limits.now(), null);
			};
			return attempt(validate, true, async (tx) => {
				await consumeFactor(tx, install.id, factor, seed, code, clock());
				await validate(tx);
				return completeChallenge(tx, value, clock());
			});
		},
		async authorize(action: Change, session: string, password: string, code: string) {
			const limits = await budget();
			const { state, seed, factor } = await snapshot();
			if ((action === "enable") === Boolean(state.enabled)) throw staleProof();
			const primary = verifiedPassword(state, await verify(null, password));
			const expires = limits.now() + 300000;
			const digest = sessionDigest(session);
			const validate = async (tx: OwnerTransaction) => {
				if (limits.now() >= expires) throw staleProof();
				await requirePrimary(tx, primary);
				await requireSession(tx, digest, clock());
			};
			const work = async (tx: OwnerTransaction) => {
				await validate(tx);
				if (seed && factor) await consumeFactor(tx, install.id, factor, seed, code, clock());
				if (action === "enable" || action === "replace") {
					const candidate = randomBytes(20);
					const envelope = sealSeed(candidateKey, candidate, install.id, action + digest);
					const proof = await replaceCandidateProof(
						tx,
						state,
						origin,
						action,
						digest,
						envelope,
						limits.now(),
					);
					return {
						kind: "candidate" as const,
						action,
						proof,
						...setupMaterial(candidate, install.id),
					};
				}
				return {
					kind: "changed" as const,
					...(await rotateSecurity(tx, install.id, action === "regenerate", clock())),
				};
			};
			const result = factor ? await attempt(validate, true, work) : await transact(install, work);
			if (result.kind === "changed" && action === "disable" && factor)
				await retireFactorKey(install.directory, factor.id).catch(() => {});
			return result;
		},
		async settings(session: string, proofFor?: (digest: string) => string | undefined) {
			const { state, factor } = await snapshot();
			const details = { enabled: !!factor, remaining: factor?.remaining ?? 0 };
			if (!proofFor) return { ...details, candidate: null };
			const limits = await budget();
			const digest = sessionDigest(session);
			const candidate = await transact(install, async (tx) => {
				await currentPolicy(tx, state);
				await requireSession(tx, digest, clock());
				const row = await resumableCandidate(tx, state, origin, digest, limits.now());
				if (!row) return null;
				const proof = proofFor(row.digest);
				if (!proof || sessionDigest(proof) !== row.digest) return null;
				const action: "replace" | "enable" = state.enabled ? "replace" : "enable";
				const seed = openSeed(candidateKey, row.candidate, install.id, action + digest);
				return { kind: "candidate" as const, action, proof, ...setupMaterial(seed, install.id) };
			});
			return { ...details, candidate };
		},
		async activate(action: "enable" | "replace", session: string, proof: string, code: string) {
			const limits = await budget();
			const { state, factor } = await snapshot();
			const digest = sessionDigest(session);
			const candidate = async (tx: OwnerTransaction) => {
				await currentPolicy(tx, state);
				await requireSession(tx, digest, clock());
				const row = await requireProof(tx, state, proof, origin, action, limits.now(), digest);
				if (!row.candidate) throw staleProof();
				return openSeed(candidateKey, row.candidate, install.id, action + digest);
			};
			const result = await attempt(
				async (tx) => {
					await candidate(tx);
				},
				!factor,
				async (tx) => {
					const seed = await candidate(tx);
					const used = checkStep(seed, code, clock(), -1);
					if (used === null) throw invalidFactor();
					const id = crypto.randomUUID(),
						key = randomBytes(32);
					try {
						await publishFactorKey(install.directory, id, key);
					} catch {
						throw new RetryableFactorError(
							"Could not publish the authenticator key. Check private storage and retry.",
							503,
						);
					}
					const envelope = sealSeed(key, seed, install.id, id);
					await candidate(tx);
					return activateFactor(tx, install.id, id, envelope, used, clock());
				},
			).catch(async (error: unknown) => {
				if (error instanceof AccessError && !(error instanceof RetryableFactorError)) throw error;
				// A rollback or rate-limit check may outlast the grant or race another confirmation.
				await transact(install, candidate);
				throw new CandidateRetry(
					error instanceof RetryableFactorError
						? error
						: new AccessError("Could not finish this change. Retry confirmation.", 503),
					proof,
				);
			});
			if (factor) await retireFactorKey(install.directory, factor.id).catch(() => {});
			return result;
		},
	};
}
