import { appendFile } from "node:fs/promises";
import { parseArgs } from "node:util";
import { decodePricingFeed, parsePricingInstant } from "../../src/lib/shared/pricing/feed";
import { decodePoyoBasis, poyoBasisByteLimit } from "../../src/lib/shared/pricing/poyo-basis";
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
import { poyoBasisPairs } from "./local-feed";

const day = 24 * 60 * 60 * 1000;
// Published blobs, trailing LF included, as publish.sh limits them. Bundled files are local.
const publishedPoyoV2ByteLimit = 64 * 1024;
const publishedPoyoV1ByteLimit = 4096;
const publishedToapisByteLimit = 4096;
const bundledByteLimit = 256 * 1024;

type Level = "notice" | "warning" | "error";
export type FreshnessCheck = { level: Level; message: string };
export type FreshnessOptions = {
	poyoV2?: string;
	poyoV1?: string;
	toapis?: string;
	bundledPoyo?: string;
	bundledToapis?: string;
	/** The price basis beside the published v2 feed, and beside the bundled feed on main. */
	poyoBasis?: string;
	bundledPoyoBasis?: string;
	warnWithinDays: number;
	failWithinDays: number;
};

type Evidence = { evidenceMs: number; expiresMs: number };
type Feed = {
	label: string;
	byteLimit: number;
	read: (value: unknown) => Evidence | undefined;
};

function poyoEvidence(feed: PoyoPricingFeed | undefined): Evidence | undefined {
	if (!feed) return;
	return { evidenceMs: poyoConfirmationMs(feed), expiresMs: poyoFeedExpiryMs(feed) };
}

/** Only v2 ToAPIs feeds decode. The frozen v1 feed is never checked. */
function toapisEvidence(value: unknown): Evidence | undefined {
	const feed = decodeToapisPricingFeed(value);
	if (!feed) return;
	return { evidenceMs: parsePricingInstant(feed.observedAt), expiresMs: toapisFeedExpiryMs(feed) };
}

const feeds = {
	poyoV2: {
		label: "Published PoYo v2 rates",
		byteLimit: publishedPoyoV2ByteLimit,
		read: (value) => poyoEvidence(decodePoyoV2Feed(value)),
	},
	poyoV1: {
		label: "Published PoYo v1 rates",
		byteLimit: publishedPoyoV1ByteLimit,
		read: (value) => poyoEvidence(decodePricingFeed(value)),
	},
	toapis: {
		label: "Published ToAPIs v2 rates",
		byteLimit: publishedToapisByteLimit,
		read: toapisEvidence,
	},
	bundledPoyo: {
		label: "Bundled PoYo rates on main",
		byteLimit: bundledByteLimit,
		read: (value) => poyoEvidence(decodePoyoPricingFeed(value)),
	},
	bundledToapis: {
		label: "Bundled ToAPIs rates on main",
		byteLimit: bundledByteLimit,
		read: toapisEvidence,
	},
} satisfies Record<string, Feed>;

/** Read a feed file. `undefined` means the file does not exist, `null` that it is unusable. */
async function readJson(path: string, byteLimit: number): Promise<unknown> {
	const file = Bun.file(path);
	if (!(await file.exists())) return;
	try {
		const bytes = await file.slice(0, byteLimit + 1).arrayBuffer();
		if (bytes.byteLength > byteLimit) return null;
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

const bases = {
	published: {
		label: "Published PoYo price basis",
		byteLimit: poyoBasisByteLimit,
		feeds: "the published v2 rates",
		// Review quotes no derived rate from an unpaired basis, so a published gap fails the run.
		absent: (label: string): FreshnessCheck => ({
			level: "error",
			message: `${label} is missing or invalid.`,
		}),
		mismatch: "error",
		remedy: "",
	},
	bundled: {
		label: "Bundled PoYo price basis on main",
		byteLimit: poyoBasisByteLimit,
		feeds: "the bundled rates",
		// Until a re-bundle adds the published basis, derived rows stay unknown-price.
		absent: (label: string): FreshnessCheck => ({
			level: "warning",
			message: `${label} is absent. Derived rows stay unknown-price until a re-bundle adds it.`,
		}),
		mismatch: "warning",
		remedy: " Derived rows stay unknown-price until a re-bundle pairs them.",
	},
} as const;

/** Check that a basis pairs with the feed beside it: the same revision and body digest. */
async function checkBasis(
	which: keyof typeof bases,
	feedJson: unknown,
	path: string,
): Promise<FreshnessCheck> {
	const { label, byteLimit, feeds, absent, mismatch, remedy } = bases[which];
	const json = await readJson(path, byteLimit);
	if (json === undefined || (which === "published" && json === null)) return absent(label);
	const basis = decodePoyoBasis(json);
	const feed = decodePoyoV2Feed(feedJson);
	if (!basis || !feed || !poyoBasisPairs(feed, basis)) {
		return { level: mismatch, message: `${label} does not pair with ${feeds}.${remedy}` };
	}
	return {
		level: "notice",
		message: `${label} pairs with revision ${feed.revision.slice(0, 12)}.`,
	};
}

/** Check every requested feed before deciding the combined result. */
export async function checkPricingFreshness(
	options: FreshnessOptions,
	nowMs: number,
): Promise<FreshnessCheck[]> {
	const checks: FreshnessCheck[] = [];
	const check = async (feed: Feed, path: string, value?: unknown) => {
		const json = value === undefined ? await readJson(path, feed.byteLimit) : value;
		checks.push(classify(feed, json === undefined ? undefined : feed.read(json), nowMs, options));
	};
	if (options.poyoV2 !== undefined) {
		const v2 = await readJson(options.poyoV2, feeds.poyoV2.byteLimit);
		// The published v1 feed deliberately ages once v2 exists.
		if (v2 !== undefined || options.poyoV1 === undefined) {
			await check(feeds.poyoV2, options.poyoV2, v2);
			if (options.poyoBasis !== undefined)
				checks.push(await checkBasis("published", v2, options.poyoBasis));
		} else await check(feeds.poyoV1, options.poyoV1);
	} else if (options.poyoV1 !== undefined) {
		await check(feeds.poyoV1, options.poyoV1);
	}
	if (options.toapis !== undefined) await check(feeds.toapis, options.toapis);
	if (options.bundledPoyo !== undefined) {
		const bundled = await readJson(options.bundledPoyo, feeds.bundledPoyo.byteLimit);
		await check(feeds.bundledPoyo, options.bundledPoyo, bundled);
		if (options.bundledPoyoBasis !== undefined)
			checks.push(await checkBasis("bundled", bundled, options.bundledPoyoBasis));
	}
	if (options.bundledToapis !== undefined) await check(feeds.bundledToapis, options.bundledToapis);
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
			"bundled-toapis": { type: "string" },
			"poyo-basis": { type: "string" },
			"bundled-poyo-basis": { type: "string" },
			"warn-within-days": { type: "string", default: "14" },
			"fail-within-days": { type: "string", default: "7" },
		},
	});
	const options = {
		poyoV2: values["poyo-v2"],
		poyoV1: values["poyo-v1"],
		toapis: values.toapis,
		bundledPoyo: values["bundled-poyo"],
		bundledToapis: values["bundled-toapis"],
		poyoBasis: values["poyo-basis"],
		bundledPoyoBasis: values["bundled-poyo-basis"],
		warnWithinDays: days(values["warn-within-days"], "warn-within-days"),
		failWithinDays: days(values["fail-within-days"], "fail-within-days"),
	};
	const files = [
		options.poyoV2,
		options.poyoV1,
		options.toapis,
		options.bundledPoyo,
		options.bundledToapis,
	];
	if (!files.some(Boolean)) {
		throw new Error(
			"Choose at least one of --poyo-v2, --poyo-v1, --toapis, --bundled-poyo or --bundled-toapis.",
		);
	}
	// A basis is checked only as one half of a pair.
	if (options.poyoBasis !== undefined && options.poyoV2 === undefined)
		throw new Error("--poyo-basis needs --poyo-v2.");
	if (options.bundledPoyoBasis !== undefined && options.bundledPoyo === undefined)
		throw new Error("--bundled-poyo-basis needs --bundled-poyo.");
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
