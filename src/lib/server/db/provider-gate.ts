import { sql } from "drizzle-orm";
import type { ProviderId } from "../../shared/providers/connections";
import type { InstallationTransaction } from "./installation";

// https://docs.poyo.ai/#10-rate-limits-concurrency
// https://docs.toapis.com/docs/en/api-reference/rate-limits/async-tasks
// Poyo permits 20 submissions/10s. ToAPIs' default group permits 5/s,
// 50/10s and 300/min. A rolling one-second ceiling of five satisfies all three.
export async function nextProviderStart(
	tx: InstallationTransaction,
	provider: ProviderId,
	kind: "submit" | "query",
	now: number,
) {
	const span = provider === "poyo" && kind === "submit" ? 10_000 : 1_000;
	const limit = kind === "query" ? 2 : provider === "poyo" ? 20 : 5;
	const until = kind === "submit" ? sql`submit_after` : sql`query_after`;
	const gate = await tx.get<{ until: number }>(sql`SELECT MAX(${until},COALESCE((
		SELECT started+${span} FROM provider_start WHERE provider=${provider} AND kind=${kind}
		AND started>${now - span} ORDER BY started DESC LIMIT 1 OFFSET ${limit - 1}
	),0)) AS until FROM provider_gate WHERE provider=${provider}`);
	return gate?.until ?? 0;
}

export async function recordProviderStart(
	tx: InstallationTransaction,
	provider: ProviderId,
	kind: "submit" | "query",
	now: number,
) {
	await tx.run(sql`DELETE FROM provider_start WHERE started<=${now - 10_000}`);
	await tx.run(sql`INSERT INTO provider_start VALUES(${provider},${kind},${now})`);
}

export function retryTime(value: string | null, now: number) {
	if (!value) return now;
	if (/^\d+$/.test(value)) return Math.min(8.64e15, now + 1_000 * Number(value));
	const absolute = Date.parse(value);
	return Number.isFinite(absolute) ? Math.max(now, absolute) : now;
}
