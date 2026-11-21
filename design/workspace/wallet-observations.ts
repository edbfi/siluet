import {
	isObservationTime,
	readWalletObservation,
	reconcileWallet,
	type WalletObservation,
} from "../../src/lib/shared/billing/wallet";
import { type DemoProvider, type FixtureRead, walletFixtures } from "./wallet-fixtures";

type ReadProblem = "access" | "cooldown" | "failed";
type WindowProblem = ReadProblem | "interrupted" | "uncertain";
type WalletWindow = {
	provider: DemoProvider;
	id: string;
	startedAt: number;
	finishedAt: number | null;
	before: WalletObservation | null;
	after: WalletObservation | null;
	overlaps: boolean;
	problem: WindowProblem | null;
	forHistory: boolean;
};
type Account = { nextRead: number; retryAt: number; last: WalletObservation };
type SeedBalance = { value: number; asOf: number };

const problems: WindowProblem[] = ["access", "cooldown", "failed", "interrupted", "uncertain"];
const recentHistoryMs = 7 * 24 * 60 * 60 * 1000;

function record(value: unknown): Record<string, unknown> {
	return value && typeof value === "object" && !Array.isArray(value)
		? (value as Record<string, unknown>)
		: {};
}

function isProvider(value: unknown): value is DemoProvider {
	return typeof value === "string" && Object.hasOwn(walletFixtures, value);
}

function restoreAccount(provider: DemoProvider, seed: SeedBalance, value: unknown): Account {
	const fixture = walletFixtures[provider];
	const { nextRead, retryAt, last } = record(value);
	const reading = readWalletObservation(last);
	return {
		nextRead:
			typeof nextRead === "number" &&
			Number.isInteger(nextRead) &&
			nextRead >= 0 &&
			nextRead <= fixture.reads.length
				? nextRead
				: 0,
		retryAt: isObservationTime(retryAt) ? retryAt : 0,
		last:
			reading?.provider === provider &&
			reading.account === fixture.scope.account &&
			reading.unit === fixture.scope.unit
				? reading
				: { ...fixture.scope, amount: String(seed.value), observedAt: seed.asOf },
	};
}

function restoreWindow(value: unknown): WalletWindow | null {
	const entry = record(value);
	const { provider, id, startedAt, finishedAt, before, after, overlaps, problem, forHistory } =
		entry;
	if (!isProvider(provider) || typeof id !== "string" || !isObservationTime(startedAt)) {
		return null;
	}
	const finished = isObservationTime(finishedAt);
	return {
		provider,
		id,
		startedAt,
		finishedAt: finished ? finishedAt : startedAt,
		before: readWalletObservation(before),
		after: finished ? readWalletObservation(after) : null,
		overlaps: overlaps === true,
		problem: finished ? (problems.find((reason) => reason === problem) ?? null) : "interrupted",
		forHistory: finished && forHistory === true,
	};
}

function compare(window: WalletWindow) {
	if (window.finishedAt === null) return { status: "pending" } as const;
	if (!window.overlaps && window.problem) {
		return { status: "unavailable", reason: window.problem } as const;
	}
	return reconcileWallet({
		...window,
		scope: walletFixtures[window.provider].scope,
		finishedAt: window.finishedAt,
	});
}

type Job = {
	id: string;
	batchId: string;
	walletRunId?: string;
	provider: string;
	model: string;
	operation: string;
	status: string;
	attempt: number;
	createdAt: number;
	sourceIds: readonly string[];
	options: Readonly<Record<string, unknown>>;
	estimate?: { status: string; unit?: string } | null;
};

const safeOptions = ["size", "resolution", "background", "output_format", "enable_safety_checker"];

function billingInputs(job: Job) {
	if (job.provider !== "poyo" || !["z-image", "seedream-5.5"].includes(job.model)) {
		return null;
	}
	const options = Object.entries(job.options).sort(([left], [right]) => left.localeCompare(right));
	if (
		options.some(
			([name, value]) =>
				!safeOptions.includes(name) || (typeof value !== "string" && typeof value !== "boolean"),
		)
	) {
		return null;
	}
	return JSON.stringify([job.model, job.operation, job.sourceIds.length, options]);
}

export function createWalletObservations(
	saved: unknown,
	seeds: Record<DemoProvider, SeedBalance>,
	hasAccess: (provider: DemoProvider) => boolean,
) {
	const stored = record(saved);
	const storedAccounts = record(stored.accounts);
	const accounts = {
		poyo: restoreAccount("poyo", seeds.poyo, storedAccounts.poyo),
		toapis: restoreAccount("toapis", seeds.toapis, storedAccounts.toapis),
	};
	let balanceChanged = false;
	const windows = new Map<DemoProvider, Map<string, WalletWindow>>([
		["poyo", new Map()],
		["toapis", new Map()],
	]);
	const active = { poyo: new Set<WalletWindow>(), toapis: new Set<WalletWindow>() };
	if (Array.isArray(stored.windows)) {
		for (const value of stored.windows) {
			const entry = restoreWindow(value);
			if (entry) windows.get(entry.provider)?.set(entry.id, entry);
		}
	}

	function observe(provider: DemoProvider, now: number) {
		const unavailable = (problem: ReadProblem) => ({ reading: null, problem, forHistory: false });
		if (!hasAccess(provider)) return unavailable("access");
		const account = accounts[provider];
		if (now < account.retryAt) return unavailable("cooldown");
		if (!isObservationTime(now) || (account.nextRead > 0 && now <= account.last.observedAt)) {
			return unavailable("failed");
		}
		const fixture = walletFixtures[provider];
		if (account.nextRead >= fixture.reads.length) return unavailable("failed");
		const read: FixtureRead | undefined = fixture.reads[account.nextRead++];
		if (!read) return unavailable("failed");
		if ("retryAfterMs" in read) {
			account.retryAt = now + read.retryAfterMs;
			return unavailable("cooldown");
		}
		const reading = { ...fixture.scope, amount: read.amount, observedAt: now };
		account.last = reading;
		balanceChanged = true;
		return {
			reading,
			problem: null,
			forHistory: "forHistory" in read && read.forHistory === true,
		};
	}

	function start(provider: DemoProvider, id: string, now: number) {
		const entries = windows.get(provider);
		if (!entries || entries.has(id)) return;
		const open = active[provider];
		const overlaps = open.size > 0;
		for (const entry of open) entry.overlaps = true;
		// A new overlap invalidates both comparisons, so skip redundant reads.
		const before = overlaps ? null : observe(provider, now);
		const entry = {
			provider,
			id,
			startedAt: now,
			finishedAt: null,
			before: before?.reading ?? null,
			after: null,
			overlaps,
			problem: before?.problem ?? null,
			forHistory: before?.forHistory ?? false,
		};
		entries.set(id, entry);
		open.add(entry);
	}

	function finish(provider: DemoProvider, id: string, now: number, uncertain: boolean) {
		const entry = windows.get(provider)?.get(id);
		if (!entry || entry.finishedAt !== null) return;
		active[provider].delete(entry);
		entry.finishedAt = now;
		if (uncertain) entry.problem = "uncertain";
		if (entry.overlaps || entry.problem === "access" || uncertain) return;
		const after = observe(provider, now);
		entry.after = after.reading;
		entry.problem ??= after.problem;
		entry.forHistory &&= after.forHistory;
	}

	return {
		start,
		finish,
		revoke(provider: DemoProvider) {
			for (const entry of active[provider]) entry.problem = "access";
		},
		isOpen(provider: DemoProvider, id: string) {
			return windows.get(provider)?.get(id)?.finishedAt === null;
		},
		balance(provider: DemoProvider) {
			const { amount, unit, observedAt } = accounts[provider].last;
			return { value: Number(amount), unit, asOf: observedAt };
		},
		takeBalanceChange() {
			const changed = balanceChanged;
			balanceChanged = false;
			return changed;
		},
		comparison(job: Job) {
			const entry = isProvider(job.provider)
				? windows.get(job.provider)?.get(job.walletRunId ?? job.batchId)
				: undefined;
			return entry ? compare(entry) : ({ status: "unavailable", reason: "missing" } as const);
		},
		history(job: Job, jobs: readonly Job[], now: number) {
			const inputs = billingInputs(job);
			if (!inputs || !isProvider(job.provider)) return null;
			const entries = windows.get(job.provider);
			const batchSizes = new Map<string, number>();
			let earliestUncertain = Infinity;
			for (const item of jobs) {
				batchSizes.set(item.batchId, (batchSizes.get(item.batchId) ?? 0) + 1);
				if (item.provider === job.provider && item.status === "uncertain") {
					earliestUncertain = Math.min(earliestUncertain, item.createdAt);
				}
			}
			let sampleCount = 0;
			let latest: { delta: string; unit: string; observedAt: number } | null = null;
			for (const item of jobs) {
				if (
					item.id === job.id ||
					item.status !== "completed" ||
					item.attempt !== 1 ||
					batchSizes.get(item.batchId) !== 1 ||
					item.estimate?.status !== "known" ||
					item.estimate.unit !== "poyo_credit" ||
					billingInputs(item) !== inputs
				) {
					continue;
				}
				const entry = entries?.get(item.batchId);
				if (!entry?.forHistory) continue;
				const sample = compare(entry);
				if (
					sample.status !== "observed" ||
					!sample.delta.startsWith("-") ||
					earliestUncertain <= sample.after.observedAt ||
					sample.after.observedAt >= job.createdAt ||
					sample.after.observedAt > now ||
					now - sample.after.observedAt > recentHistoryMs
				) {
					continue;
				}
				sampleCount++;
				if (!latest || latest.observedAt < sample.after.observedAt) {
					latest = { delta: sample.delta, unit: sample.unit, observedAt: sample.after.observedAt };
				}
			}
			return latest && { ...latest, sampleCount };
		},
		snapshot() {
			return {
				accounts,
				windows: [...windows.values()].flatMap((entries) => [...entries.values()]),
			};
		},
	};
}

if (typeof window !== "undefined") {
	Object.assign(window, { SiluetWallets: { create: createWalletObservations } });
}
