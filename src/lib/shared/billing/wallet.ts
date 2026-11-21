export type WalletScope = Readonly<{ provider: string; account: string; unit: string }>;

export type WalletObservation = WalletScope & Readonly<{ amount: string; observedAt: number }>;

export type WalletComparison =
	| Readonly<{
			status: "observed";
			delta: string;
			unit: string;
			before: WalletObservation;
			after: WalletObservation;
	  }>
	| Readonly<{
			status: "unavailable";
			reason: "missing" | "overlap" | "scope-mismatch" | "invalid-reading" | "invalid-time";
	  }>;

type WalletInterval = Readonly<{
	scope: WalletScope;
	before: unknown;
	after: unknown;
	startedAt: number;
	finishedAt: number;
	overlaps: boolean;
}>;

const balancePattern = /^(0|[1-9]\d{0,23})(?:\.(\d{1,24}))?$/;

export function isObservationTime(value: unknown): value is number {
	return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 && value <= 8.64e15;
}

export function readWalletObservation(value: unknown): WalletObservation | null {
	if (!value || typeof value !== "object") return null;
	const { provider, account, unit, amount, observedAt } = value as Record<string, unknown>;
	if (
		typeof provider !== "string" ||
		!provider ||
		typeof account !== "string" ||
		!account ||
		typeof unit !== "string" ||
		!unit ||
		typeof amount !== "string" ||
		!balancePattern.test(amount) ||
		!isObservationTime(observedAt)
	) {
		return null;
	}
	return { provider, account, unit, amount, observedAt };
}

function matchesScope(observation: WalletObservation, scope: WalletScope) {
	return (
		observation.provider === scope.provider &&
		observation.account === scope.account &&
		observation.unit === scope.unit
	);
}

function difference(before: string, after: string): string {
	const [beforeWhole, beforeFraction = ""] = before.split(".");
	const [afterWhole, afterFraction = ""] = after.split(".");
	const decimals = Math.max(beforeFraction.length, afterFraction.length);
	const start = BigInt(beforeWhole + beforeFraction.padEnd(decimals, "0"));
	const end = BigInt(afterWhole + afterFraction.padEnd(decimals, "0"));
	const delta = end - start;
	const magnitude = (delta < 0n ? -delta : delta).toString().padStart(decimals + 1, "0");
	const whole = magnitude.slice(0, magnitude.length - decimals);
	const fraction = magnitude.slice(whole.length).replace(/0+$/, "");
	return `${delta < 0n ? "-" : ""}${whole}${fraction ? `.${fraction}` : ""}`;
}

// This is account-level movement between reads. Other activity can affect any interval.
export function reconcileWallet(interval: WalletInterval): WalletComparison {
	if (interval.overlaps) return { status: "unavailable", reason: "overlap" };
	if (interval.before == null || interval.after == null)
		return { status: "unavailable", reason: "missing" };
	const before = readWalletObservation(interval.before);
	const after = readWalletObservation(interval.after);
	if (!before || !after) return { status: "unavailable", reason: "invalid-reading" };
	if (!matchesScope(before, interval.scope) || !matchesScope(after, interval.scope))
		return { status: "unavailable", reason: "scope-mismatch" };
	if (
		!isObservationTime(interval.startedAt) ||
		!isObservationTime(interval.finishedAt) ||
		before.observedAt > interval.startedAt ||
		interval.startedAt > interval.finishedAt ||
		interval.finishedAt > after.observedAt ||
		before.observedAt >= after.observedAt
	) {
		return { status: "unavailable", reason: "invalid-time" };
	}
	return {
		status: "observed",
		delta: difference(before.amount, after.amount),
		unit: interval.scope.unit,
		before,
		after,
	};
}
