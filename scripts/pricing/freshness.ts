import { appendFile } from "node:fs/promises";
import { parseArgs } from "node:util";
import { decodePricingFeed, parsePricingInstant } from "../../src/lib/shared/pricing/feed";
import {
	decodePoyoPricingFeed,
	decodePoyoV2Feed,
	type PoyoPricingFeed,
	poyoConfirmationMs,
	poyoFeedExpiryMs,
} from "../../src/lib/shared/pricing/poyo-feed";
import {
	decodeToapisPricingFeed,
	toapisFeedExpiryMs,
} from "../../src/lib/shared/pricing/toapis-feed";

const day = 24 * 60 * 60 * 1000;
const fileByteLimit = 256 * 1024;

type Level = "notice" | "warning" | "error";
export type FreshnessCheck = { level: Level; message: string };
export type FreshnessOptions = {
	poyoV2?: string;
	poyoV1?: string;
	toapis?: string;
	bundledPoyo?: string;
	warnWithinDays: number;
	failWithinDays: number;
};

type Evidence = { evidenceMs: number; expiresMs: number };
type Feed = { label: string; read: (value: unknown) => Evidence | undefined };

function poyoEvidence(feed: PoyoPricingFeed | undefined): Evidence | undefined {
	if (!feed) return;
	return { evidenceMs: poyoConfirmationMs(feed), expiresMs: poyoFeedExpiryMs(feed) };
}

const feeds = {
	poyoV2: {
		label: "Published PoYo v2 rates",
		read: (value) => poyoEvidence(decodePoyoV2Feed(value)),
	},
	poyoV1: {
		label: "Published PoYo v1 rates",
		read: (value) => poyoEvidence(decodePricingFeed(value)),
	},
	toapis: {
		label: "Published ToAPIs rates",
		read(value) {
			const feed = decodeToapisPricingFeed(value);
			if (!feed) return;
			return {
				evidenceMs: parsePricingInstant(feed.observedAt),
				expiresMs: toapisFeedExpiryMs(feed),
			};
		},
	},
	bundledPoyo: {
		label: "Bundled PoYo rates on main",
		read: (value) => poyoEvidence(decodePoyoPricingFeed(value)),
	},
} satisfies Record<string, Feed>;

/** Read a feed file. `undefined` means the file does not exist. */
async function readJson(path: string): Promise<unknown> {
	const file = Bun.file(path);
	if (!(await file.exists())) return;
	try {
		const bytes = await file.slice(0, fileByteLimit + 1).arrayBuffer();
		if (bytes.byteLength > fileByteLimit) return null;
		return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
	} catch {
		return null;
	}
}

function classify(
	{ label }: Feed,
	evidence: Evidence | undefined,
	nowMs: number,
	{ warnWithinDays, failWithinDays }: FreshnessOptions,
): FreshnessCheck {
	if (!evidence) return { level: "error", message: `${label} are missing or invalid.` };
	if (evidence.evidenceMs > nowMs) {
		return { level: "error", message: `${label} are dated in the future.` };
	}
	const expires = new Date(evidence.expiresMs).toISOString().replace(".000Z", "Z");
	const daysLeft = (evidence.expiresMs - nowMs) / day;
	const message = `${label} expire ${expires} (${daysLeft.toFixed(1)} days left).`;
	if (daysLeft <= failWithinDays) return { level: "error", message };
	if (daysLeft <= warnWithinDays) return { level: "warning", message };
	return { level: "notice", message };
}

/** Check every requested feed before deciding the combined result. */
export async function checkPricingFreshness(
	options: FreshnessOptions,
	nowMs: number,
): Promise<FreshnessCheck[]> {
	const checks: FreshnessCheck[] = [];
	const check = async (feed: Feed, path: string, value?: unknown) => {
		const json = value === undefined ? await readJson(path) : value;
		checks.push(classify(feed, json === undefined ? undefined : feed.read(json), nowMs, options));
	};
	if (options.poyoV2 !== undefined) {
		const v2 = await readJson(options.poyoV2);
		// The published v1 feed deliberately ages once v2 exists.
		if (v2 !== undefined || options.poyoV1 === undefined)
			await check(feeds.poyoV2, options.poyoV2, v2);
		else await check(feeds.poyoV1, options.poyoV1);
	} else if (options.poyoV1 !== undefined) {
		await check(feeds.poyoV1, options.poyoV1);
	}
	if (options.toapis !== undefined) await check(feeds.toapis, options.toapis);
	if (options.bundledPoyo !== undefined) await check(feeds.bundledPoyo, options.bundledPoyo);
	return checks;
}

function days(value: string, flag: string): number {
	if (!/^\d{1,3}$/.test(value)) throw new Error(`--${flag} requires a whole number of days.`);
	return Number(value);
}

export function readFreshnessArgs(args: string[]): FreshnessOptions {
	const { values } = parseArgs({
		args,
		strict: true,
		allowPositionals: false,
		options: {
			"poyo-v2": { type: "string" },
			"poyo-v1": { type: "string" },
			toapis: { type: "string" },
			"bundled-poyo": { type: "string" },
			"warn-within-days": { type: "string", default: "14" },
			"fail-within-days": { type: "string", default: "7" },
		},
	});
	const options = {
		poyoV2: values["poyo-v2"],
		poyoV1: values["poyo-v1"],
		toapis: values.toapis,
		bundledPoyo: values["bundled-poyo"],
		warnWithinDays: days(values["warn-within-days"], "warn-within-days"),
		failWithinDays: days(values["fail-within-days"], "fail-within-days"),
	};
	if (![options.poyoV2, options.poyoV1, options.toapis, options.bundledPoyo].some(Boolean)) {
		throw new Error("Choose at least one of --poyo-v2, --poyo-v1, --toapis or --bundled-poyo.");
	}
	if (options.warnWithinDays < options.failWithinDays) {
		throw new Error("--warn-within-days must be at least --fail-within-days.");
	}
	return options;
}

if (import.meta.main) {
	try {
		const checks = await checkPricingFreshness(readFreshnessArgs(Bun.argv.slice(2)), Date.now());
		for (const { level, message } of checks) {
			console.log(`::${level} title=Pricing freshness::${message}`);
			if (process.env.GITHUB_STEP_SUMMARY) {
				await appendFile(process.env.GITHUB_STEP_SUMMARY, `- ${level}: ${message}\n`);
			}
		}
		if (checks.some(({ level }) => level === "error")) process.exitCode = 1;
	} catch (error) {
		console.error(error instanceof Error ? error.message : "Pricing freshness check failed.");
		process.exitCode = 1;
	}
}
