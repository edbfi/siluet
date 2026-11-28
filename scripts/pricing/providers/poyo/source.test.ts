import { expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { queueRows } from "../../../../src/lib/shared/media-catalog/image-queue.ts";
import { estimatePrice } from "../../../../src/lib/shared/pricing/estimate.ts";
import { decodePoyoV2Feed } from "../../../../src/lib/shared/pricing/poyo-feed.ts";
import pinned from "../../../media-catalog/sources/poyo-ec73207.json";
import { canonicalJson } from "../../local-feed.ts";
import h3Contract from "./h3-max-contract.json";
import { collectPoyoPricing } from "./source.ts";

const revision = "1234567890abcdef1234567890abcdef12345678";
const sourceDate = "2026-11-18T14:43:22Z";
// One pinned clock dates the history check, floored to the second.
const clock = () => Date.parse("2026-11-22T13:30:00.750Z");
const confirmedAt = "2026-11-22T13:30:00Z";
const license = "\uFEFFSynthetic license for offline tests\n";
const commitsUrl =
	"https://api.github.com/repos/PoyoAPI/poyo-devtools/commits?path=artifacts%2Fcapability-catalog.json&per_page=1";
const rawBase = `https://raw.githubusercontent.com/PoyoAPI/poyo-devtools/${revision}/`;

function fixture() {
	const zImage = {
		model_id: "z-image",
		category: "text2img",
		service_type: "generate",
		execution_mode: "async",
		status: "stable",
		output_schema: { type: "object" },
		input_schema: {
			type: "object",
			description:
				"Input parameters for generation. `size` is required for text-to-image. When `image_urls` is present, the request is routed to image editing automatically and `size` becomes optional.",
			required: ["prompt"],
			properties: {
				prompt: { type: "string", maxLength: 1000 },
				size: { type: "string", enum: ["1:1", "4:3", "3:4", "16:9", "9:16"] },
				image_urls: { type: "array", items: { type: "string", format: "uri" }, maxItems: 1 },
				enable_safety_checker: { type: "boolean", default: true },
			},
		},
		billing: {
			type: "fixed",
			unit: "request",
			credits: 3.25,
			input_credits: null,
			output_credits: null,
		},
	};
	const seedream = {
		model_id: "seedream-5.5",
		category: "image",
		service_type: "generate",
		execution_mode: "async",
		status: "stable",
		output_schema: { type: "object" },
		input_schema: {
			type: "object",
			required: ["prompt"],
			additionalProperties: false,
			description: "Generate one image. With image_urls, edit or combine the reference images.",
			properties: {
				prompt: { type: "string", minLength: 5, maxLength: 5000 },
				size: {
					type: "string",
					enum: ["1:1", "4:3", "3:4", "16:9", "9:16", "3:2", "2:3", "21:9", "auto"],
				},
				image_urls: {
					type: "array",
					items: { type: "string", format: "uri" },
					minItems: 1,
					maxItems: 10,
				},
				enable_safety_checker: { type: "boolean", default: true },
				resolution: { type: "string", enum: ["1K", "1.5K", "2K"], default: "2K" },
				background: { type: "string", enum: ["auto", "transparent", "opaque"], default: "auto" },
				output_format: { type: "string", enum: ["png", "jpeg"], default: "png" },
			},
		},
		billing: {
			type: "parameterized",
			unit: "image",
			credits: null,
			formula: "resolution_credits[resolution] + reference_image_count * input_image_credits",
			parameters: {
				resolution: "1K, 1.5K or 2K (defaults to 2K)",
				reference_image_count: "number of image_urls (0 for text-to-image)",
			},
			input_credits: null,
			output_credits: null,
			resolution_credits: { "1K": 4.75, "2K": 8, "1.5K": 5 },
			input_image_credits: 1.125,
		},
	};
	const video = {
		model_id: "h3-max",
		category: "video",
		service_type: "generate",
		execution_mode: "async",
		status: "stable",
		output_schema: { type: "object" },
		input_schema: structuredClone(h3Contract.input_schema),
		billing: {
			...structuredClone(h3Contract.billingRule),
			resolution_credits_per_second: { "480p": 10, "768p": 16, "1080p": 32 },
		},
	};
	const catalog: {
		schema_version: string;
		has_more: boolean;
		next_cursor: null;
		items: { model_id: string }[];
	} = {
		schema_version: "v1-012345abcdef",
		has_more: false,
		next_cursor: null,
		items: [
			...Array.from({ length: 250 }, (_, index) => ({
				model_id: `unrelated-model-${index}`,
				input_schema: { type: "object" },
				output_schema: { type: "object" },
				billing: { type: "unsupported" },
			})),
			video,
			seedream,
			zImage,
		],
	};
	return { catalog, seedream, zImage, video };
}

function source(
	catalog: string = JSON.stringify(fixture().catalog),
	overrides: Record<string, () => Response> = {},
	githubToken?: string,
) {
	const seen: string[] = [];
	return {
		seen,
		async fetch(url: string, init: RequestInit) {
			expect(init.redirect).toBe("error");
			expect(init.signal).toBeDefined();
			const authorization = new Headers(init.headers).get("Authorization");
			expect(authorization).toBe(
				url === commitsUrl && githubToken ? `Bearer ${githubToken}` : null,
			);
			seen.push(url);
			if (overrides[url]) return overrides[url]();
			if (url === commitsUrl) {
				expect(new Headers(init.headers).get("X-GitHub-Api-Version")).toBe("2022-11-28");
				return Response.json([{ sha: revision, commit: { committer: { date: sourceDate } } }]);
			}
			if (url === `${rawBase}artifacts/capability-catalog.json`) return new Response(catalog);
			if (url === `${rawBase}LICENSE`) return new Response(license);
			throw new Error("Unexpected source request");
		},
	};
}

type Gap = NonNullable<Parameters<typeof collectPoyoPricing>[2]>;

/** The feed alone, collected without derived rate keys. */
function collectFeed(
	fetchSource: Parameters<typeof collectPoyoPricing>[0],
	reportGap?: Gap,
	now?: () => number,
	githubToken?: string,
) {
	return collectPoyoPricing(fetchSource, license, reportGap, now, githubToken, []).then(
		({ feed }) => feed,
	);
}

test("collects the whole supported set with exact decimals and the path commit date", async () => {
	const upstream = source();
	const feed = await collectFeed(upstream.fetch, undefined, clock);

	expect(feed).toEqual({
		version: 2,
		provider: "poyo",
		revision,
		sourceDate,
		confirmedAt,
		rates: {
			"z-image": { kind: "per-request", credits: "3.25" },
			"seedream-5.5": {
				kind: "per-image-with-references",
				resolutions: { "1K": "4.75", "1.5K": "5", "2K": "8" },
				perReference: "1.125",
			},
			"h3-max": {
				kind: "per-second-by-resolution",
				resolutions: { "480p": "10", "768p": "16" },
			},
		},
	});
	expect(upstream.seen).toEqual([
		commitsUrl,
		`${rawBase}artifacts/capability-catalog.json`,
		`${rawBase}LICENSE`,
	]);
	expect(await collectFeed(source().fetch, undefined, clock)).toEqual(feed);
});

test("authenticates only the history request when a GitHub token is set", async () => {
	const token = "fixture-github-token";
	const upstream = source(undefined, {}, token);
	await collectFeed(upstream.fetch, undefined, clock, token);
	expect(upstream.seen).toHaveLength(3);
	const anonymous = source();
	await collectFeed(anonymous.fetch, undefined, clock, "");
	expect(anonymous.seen).toHaveLength(3);
});

test("rejects a catalog commit dated after the confirmation clock", async () => {
	const upstream = source(undefined, {
		[commitsUrl]: () =>
			Response.json([{ sha: revision, commit: { committer: { date: "2026-11-22T13:30:01Z" } } }]),
	});
	await expect(collectFeed(upstream.fetch, undefined, clock)).rejects.toThrow("future");
	expect(upstream.seen).toEqual([commitsUrl]);
	const atClock = source(undefined, {
		[commitsUrl]: () =>
			Response.json([{ sha: revision, commit: { committer: { date: confirmedAt } } }]),
	});
	expect(await collectFeed(atClock.fetch, undefined, clock)).toMatchObject({
		sourceDate: confirmedAt,
		confirmedAt,
	});
});

test("allows reviewed rate fields to change without changing the rules", async () => {
	const { catalog, zImage, seedream } = fixture();
	zImage.billing.credits = 12;
	seedream.billing.resolution_credits["1.5K"] = 6.5;
	const feed = await collectFeed(source(JSON.stringify(catalog)).fetch);

	expect(feed.rates["z-image"]).toEqual({ kind: "per-request", credits: "12" });
	expect(feed.rates["seedream-5.5"]).toMatchObject({ resolutions: { "1.5K": "6.5" } });
});

test.each([
	[
		"catalog version",
		({ catalog }) => {
			catalog.schema_version = "v2-012345abcdef";
		},
	],
	[
		"partial catalog",
		({ catalog }) => {
			catalog.has_more = true;
		},
	],
	[
		"truncated catalog",
		({ catalog }) => {
			catalog.items = catalog.items.slice(-2);
		},
	],
	[
		"a full count of identity-only rows",
		({ catalog }) => {
			catalog.items = catalog.items.map(({ model_id }) => ({ model_id }));
		},
	],
	[
		"an incomplete row in an otherwise valid catalog",
		({ catalog }) => {
			catalog.items[0] = { model_id: "incomplete-model" };
		},
	],
	[
		"duplicate model",
		({ catalog, zImage }) => {
			catalog.items.push(zImage);
		},
	],
] satisfies [string, (input: ReturnType<typeof fixture>) => void][])(
	"fails collection on %s",
	async (_case, change) => {
		const input = fixture();
		change(input);
		await expect(collectFeed(source(JSON.stringify(input.catalog)).fetch)).rejects.toThrow(
			"catalog",
		);
	},
);

test.each([
	[
		"missing Z-Image",
		"z-image",
		({ catalog }) => {
			catalog.items.pop();
		},
	],
	[
		"request billing basis",
		"z-image",
		({ zImage }) => {
			zImage.billing.unit = "image";
		},
	],
	[
		"missing billing parameters",
		"seedream-5.5",
		({ seedream }) => {
			Reflect.deleteProperty(seedream.billing, "parameters");
		},
	],
	[
		"different formula",
		"seedream-5.5",
		({ seedream }) => {
			seedream.billing.formula += " + 1";
		},
	],
	[
		"changed reference units",
		"seedream-5.5",
		({ seedream }) => {
			seedream.billing.parameters.reference_image_count = "number of successful uploads";
		},
	],
	[
		"additional billing rules",
		"seedream-5.5",
		({ seedream }) => {
			Object.assign(seedream.billing, { minimum_credits: 10 });
		},
	],
	[
		"unreviewed model metadata",
		"seedream-5.5",
		({ seedream }) => {
			Object.assign(seedream, { promotion_expiry: "2026-12-10T00:00:00Z" });
		},
	],
	[
		"more images per submission",
		"seedream-5.5",
		({ seedream }) => {
			seedream.input_schema.description = "Generate multiple images per request.";
		},
	],
	[
		"unexpected resolution rate",
		"seedream-5.5",
		({ seedream }) => {
			Object.assign(seedream.billing.resolution_credits, { "4K": 20 });
		},
	],
	[
		"new output-count option",
		"seedream-5.5",
		({ seedream }) => {
			Object.assign(seedream.input_schema.properties, { output_count: { type: "integer" } });
		},
	],
	[
		"a new input named like a schema annotation",
		"seedream-5.5",
		({ seedream }) => {
			Object.assign(seedream.input_schema.properties, { description: { type: "string" } });
		},
	],
	[
		"nested resolution const",
		"seedream-5.5",
		({ seedream }) => {
			Object.assign(seedream.input_schema.properties.resolution, { const: "2K" });
		},
	],
	[
		"unreviewed array item constraint",
		"z-image",
		({ zImage }) => {
			Object.assign(zImage.input_schema.properties.image_urls.items, { pattern: "^https:" });
		},
	],
	[
		"different resolution default",
		"seedream-5.5",
		({ seedream }) => {
			seedream.input_schema.properties.resolution.default = "1K";
		},
	],
	[
		"reference limit drift",
		"seedream-5.5",
		({ seedream }) => {
			seedream.input_schema.properties.image_urls.maxItems = 11;
		},
	],
	[
		"different route",
		"z-image",
		({ zImage }) => {
			zImage.service_type = "edit";
		},
	],
	[
		"negative rate",
		"z-image",
		({ zImage }) => {
			zImage.billing.credits = -1;
		},
	],
	[
		"zero rate",
		"z-image",
		({ zImage }) => {
			zImage.billing.credits = 0;
		},
	],
] satisfies [string, "z-image" | "seedream-5.5", (input: ReturnType<typeof fixture>) => void][])(
	"reports a gap for %s and preserves the other rate",
	async (_case, model, change) => {
		const input = fixture();
		change(input);
		const gaps: string[] = [];
		const feed = await collectFeed(source(JSON.stringify(input.catalog)).fetch, (model) =>
			gaps.push(model),
		);
		const otherModel = model === "z-image" ? "seedream-5.5" : "z-image";

		expect(feed.rates[model]).toEqual({ kind: "unavailable" });
		expect(feed.rates[otherModel].kind).not.toBe("unavailable");
		expect(gaps).toEqual([model]);
		expect(feed.sourceDate).toBe(sourceDate);
	},
);

test("rejects rate syntax or precision outside the feed contract", async () => {
	const catalog = JSON.stringify(fixture().catalog);
	for (const invalid of ['"3.25"', "3.2500000000000000000001", "3.25e0", "-0"]) {
		const upstream = source(catalog.replace("3.25", invalid));
		const feed = await collectFeed(upstream.fetch);
		expect(feed.rates["z-image"]).toEqual({ kind: "unavailable" });
	}
});

test("rejects invalid commit provenance before fetching the raw URL", async () => {
	for (const sha of ["main", revision]) {
		const upstream = source(undefined, {
			[commitsUrl]: () =>
				Response.json([{ sha, commit: { committer: { date: "2026-02-30T00:00:00Z" } } }]),
		});
		await expect(collectFeed(upstream.fetch)).rejects.toThrow("commit provenance");
		expect(upstream.seen).toEqual([commitsUrl]);
	}
});

test("rejects a future path commit date before requesting the raw artifact", async () => {
	const future = new Date(Date.now() + 60_000).toISOString().replace(/\.\d{3}Z$/, "Z");
	const upstream = source(undefined, {
		[commitsUrl]: () => Response.json([{ sha: revision, commit: { committer: { date: future } } }]),
	});
	await expect(collectFeed(upstream.fetch)).rejects.toThrow("future");
	expect(upstream.seen).toEqual([commitsUrl]);
});

test("rejects failed downloads, oversized bodies, malformed JSON, and changes to the upstream license", async () => {
	const artifactUrl = `${rawBase}artifacts/capability-catalog.json`;
	for (const [override, message] of [
		[{ [artifactUrl]: () => new Response(null, { status: 429 }) }, "429"],
		[{ [artifactUrl]: () => new Response("x".repeat(2 ** 22 + 1)) }, "size limit"],
		[{ [artifactUrl]: () => new Response("{") }, "invalid JSON"],
		[{ [`${rawBase}LICENSE`]: () => new Response("License changed") }, "license"],
	] as const) {
		await expect(collectFeed(source(undefined, override).fetch)).rejects.toThrow(message);
	}
});

test.each([
	[
		"a reference-mode formula change",
		(video: H3Row) => {
			video.billing.parameters.reference_tokens = "computed for all requests";
		},
	],
	[
		"a missing resolution",
		(video: H3Row) => {
			delete (video.billing.resolution_credits_per_second as Record<string, number>)["768p"];
		},
	],
	[
		"a widened duration",
		(video: H3Row) => {
			video.input_schema.properties.duration.maximum = 20;
		},
	],
	[
		"a new input",
		(video: H3Row) => {
			(video.input_schema.properties as Record<string, unknown>).seed = { type: "integer" };
		},
	],
	[
		"a fractional rate",
		(video: H3Row) => {
			video.billing.resolution_credits_per_second["480p"] = 10.0000001;
		},
	],
] as const)("%s withholds only the H3 rate", async (_name, change) => {
	const { catalog, video } = fixture();
	change(video);
	const gaps: string[] = [];
	const feed = await collectFeed(
		source(JSON.stringify(catalog)).fetch,
		(model) => gaps.push(model),
		clock,
	);
	expect(feed.rates["h3-max"]).toEqual({ kind: "unavailable" });
	expect(feed.rates["z-image"]).toEqual({ kind: "per-request", credits: "3.25" });
	expect(gaps).toEqual(["h3-max"]);
});

type H3Row = ReturnType<typeof fixture>["video"];

const sha256 = (text: string) => createHash("sha256").update(text).digest("hex");
const shipped = ["z-image", "seedream-5.5", "h3-max"];

/** The fixture catalog with more rows, each given the output schema every catalog row has. */
function withEntries(entries: readonly object[]) {
	const { catalog } = fixture();
	catalog.items.push(
		...entries.map((entry) => ({ output_schema: { type: "object" }, ...entry }) as never),
	);
	return JSON.stringify(catalog);
}

function pinnedEntry(model: string) {
	const entry = pinned.entries.find(({ model_id }) => model_id === model);
	if (!entry) throw new Error(`${model} is not in the pinned catalog.`);
	return entry;
}

function imageEntry(model_id: string, billing: Record<string, unknown>) {
	const route = { category: "image", service_type: "generate", execution_mode: "async" };
	return { model_id, ...route, status: "stable", input_schema: { type: "object" }, billing };
}

const derivedRates = (rates: Readonly<Record<string, unknown>>) =>
	Object.fromEntries(Object.entries(rates).filter(([key]) => !shipped.includes(key)));

test("rates each queued row whose billing fits a kind exactly and binds the row's own basis", async () => {
	const gaps: [string, string][] = [];
	const { feed, basis } = await collectPoyoPricing(
		source(withEntries(queueRows.map(({ rateKey }) => pinnedEntry(rateKey)))).fetch,
		license,
		(model, reason) => gaps.push([model, reason]),
		clock,
	);
	const perRequest = (credits: string) => ({ kind: "per-request", credits });
	const derived = derivedRates(feed.rates);
	expect(derived).toEqual({
		"flux-3-klein": {
			kind: "per-image-by-resolution",
			resolutions: { "1K": "1.8", "2K": "2.8", "4K": "7.2" },
		},
		"gpt-4o-image": perRequest("4"),
		"gpt-image-1.5": perRequest("2"),
		"kling-o3-image": {
			kind: "per-request-by-resolution",
			resolutions: { "1K": "3.5", "2K": "3.5", "4K": "7" },
		},
		"nano-banana-2": perRequest("8"),
		"nano-banana-pro": {
			kind: "per-request-by-resolution",
			resolutions: { "1K": "18", "2K": "18", "4K": "35" },
		},
		"qwen-image-2.1": { kind: "per-request-by-resolution", resolutions: { "1K": "6", "2K": "10" } },
		"seedream-4": perRequest("5"),
		"seedream-4.5": perRequest("5"),
		"seedream-5.0-flash": perRequest("4"),
		"seedream-5.0-lite": perRequest("5"),
		"wan-2.7-image": perRequest("4.2"),
		"wan-2.7-image-pro": perRequest("10.5"),
	});
	const dynamic = "Its price depends on usage that Siluet does not evaluate.";
	const references = "Its price depends on reference images, which Siluet does not evaluate.";
	expect(gaps).toEqual([
		["flux-dev", dynamic],
		["flux-schnell", dynamic],
		["grok-imagine-image-2.0", references],
		["grok-imagine-image-quality", references],
	]);
	// An unchanged entry's digest is the projection's basis, so its rate applies to the row.
	expect(basis.digests).toEqual(
		Object.fromEntries(
			queueRows.filter(({ rateKey }) => rateKey in derived).map((row) => [row.rateKey, row.basis]),
		),
	);
	expect(basis.revision).toBe(feed.revision);
	expect(basis.feedSha256).toBe(sha256(canonicalJson(decodePoyoV2Feed(feed))));
	expect(basis.feedSha256).not.toBe(sha256(`${canonicalJson(feed)}\n`));
});

test("normalises tier keys and reports every other billing as a gap with its reason", async () => {
	const none = { credits: null, input_credits: null, output_credits: null };
	const tiers = (resolution_credits: Record<string, number>) => ({
		type: "tiered",
		unit: "request",
		...none,
		formula: "resolution_credits[resolution]",
		resolution_credits,
	});
	const entries = [
		imageEntry("star-tiers", tiers({ "480*832": 2, "832*480": 2.5 })),
		imageEntry("fixed-image", { type: "fixed", unit: "image", credits: 2 }),
		imageEntry("case-tiers", tiers({ "1080p": 2, "1080P": 3 })),
		imageEntry("unreviewed-field", { type: "fixed", unit: "request", credits: 2, minimum: 1 }),
		imageEntry("zero-tier", tiers({ "1K": 0 })),
		pinnedEntry("gpt-image-2"),
	];
	const gaps: [string, string][] = [];
	const { feed, basis } = await collectPoyoPricing(
		source(withEntries(entries)).fetch,
		license,
		(model, reason) => gaps.push([model, reason]),
		clock,
		"",
		[...entries.map(({ model_id }) => model_id), "missing-model"],
	);
	expect(derivedRates(feed.rates)).toEqual({
		"star-tiers": {
			kind: "per-request-by-resolution",
			resolutions: { "480x832": "2", "832x480": "2.5" },
		},
	});
	const unfit = "Its billing does not fit a rate kind Siluet quotes.";
	expect(gaps).toEqual([
		["fixed-image", unfit],
		["case-tiers", "Two of its resolution tiers normalise to the same key."],
		["unreviewed-field", unfit],
		["zero-tier", "The rate is outside the reviewed positive decimal format."],
		[
			"gpt-image-2",
			"Its price depends on quality and billable resolution, which Siluet does not evaluate.",
		],
		["missing-model", "The model is missing from the complete catalog."],
	]);
	expect(Object.keys(basis.digests)).toEqual(["star-tiers"]);
});

test("an older build keeps a feed with new kinds, 2K tiers and a three-level table, and quotes none of them", async () => {
	const { feed } = await collectPoyoPricing(
		source(withEntries([pinnedEntry("kling-o3-image")])).fetch,
		license,
		undefined,
		clock,
		"",
		["kling-o3-image"],
	);
	const table = { kind: "per-image-by-quality", table: { "2K": { low: "12", medium: "16" } } };
	const wire = JSON.parse(
		JSON.stringify({ ...feed, rates: { ...feed.rates, "grok-imagine-image-2.0": table } }),
	);
	const decoded = decodePoyoV2Feed(wire);
	expect<unknown>(decoded?.rates["kling-o3-image"]).toEqual(feed.rates["kling-o3-image"]);
	expect<unknown>(decoded?.rates["grok-imagine-image-2.0"]).toEqual(table);
	const now = Date.parse(confirmedAt);
	const request = { provider: "poyo", operation: "generate", sourceCount: 0, count: 1 };
	for (const model of ["kling-o3-image", "grok-imagine-image-2.0"]) {
		const options = { resolution: "2K" };
		expect(estimatePrice(wire, { ...request, model, options, retryLimit: 0 }, now)).toMatchObject({
			status: "unknown",
		});
	}
	const zImage = { ...request, model: "z-image", options: { size: "1:1" }, retryLimit: 0 };
	expect(estimatePrice(wire, zImage, now)).toMatchObject({ status: "known", perRequest: "3.25" });
});

test("refuses a handoff over the environment cap and a basis over its own limit", async () => {
	const fixed = (model: string) =>
		imageEntry(model, { type: "fixed", unit: "request", credits: 1 });
	const keys = (count: number, length: number) =>
		Array.from({ length: count }, (_, index) => `m${String(index).padStart(length - 1, "0")}`);
	for (const [models, message] of [
		[keys(900, 128), "The PoYo pricing handoff exceeds 120 KiB."],
		[keys(300, 60), "The PoYo price basis exceeds 32 KiB."],
	] as const) {
		const upstream = source(withEntries(models.map(fixed))).fetch;
		await expect(
			collectPoyoPricing(upstream, license, undefined, clock, "", models),
		).rejects.toThrow(message);
	}
	const fits = keys(200, 60);
	const { basis } = await collectPoyoPricing(
		source(withEntries(fits.map(fixed))).fetch,
		license,
		undefined,
		clock,
		"",
		fits,
	);
	expect(Object.keys(basis.digests)).toHaveLength(200);
});
