import { expect, test } from "bun:test";
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
			seedream,
			zImage,
		],
	};
	return { catalog, seedream, zImage };
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

test("collects the whole supported set with exact decimals and the path commit date", async () => {
	const upstream = source();
	const feed = await collectPoyoPricing(upstream.fetch, license, undefined, clock);

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
		},
	});
	expect(upstream.seen).toEqual([
		commitsUrl,
		`${rawBase}artifacts/capability-catalog.json`,
		`${rawBase}LICENSE`,
	]);
	expect(await collectPoyoPricing(source().fetch, license, undefined, clock)).toEqual(feed);
});

test("authenticates only the history request when a GitHub token is set", async () => {
	const token = "fixture-github-token";
	const upstream = source(undefined, {}, token);
	await collectPoyoPricing(upstream.fetch, license, undefined, clock, token);
	expect(upstream.seen).toHaveLength(3);
	const anonymous = source();
	await collectPoyoPricing(anonymous.fetch, license, undefined, clock, "");
	expect(anonymous.seen).toHaveLength(3);
});

test("rejects a catalog commit dated after the confirmation clock", async () => {
	const upstream = source(undefined, {
		[commitsUrl]: () =>
			Response.json([{ sha: revision, commit: { committer: { date: "2026-11-22T13:30:01Z" } } }]),
	});
	await expect(collectPoyoPricing(upstream.fetch, license, undefined, clock)).rejects.toThrow(
		"future",
	);
	expect(upstream.seen).toEqual([commitsUrl]);
	const atClock = source(undefined, {
		[commitsUrl]: () =>
			Response.json([{ sha: revision, commit: { committer: { date: confirmedAt } } }]),
	});
	expect(await collectPoyoPricing(atClock.fetch, license, undefined, clock)).toMatchObject({
		sourceDate: confirmedAt,
		confirmedAt,
	});
});

test("allows reviewed rate fields to change without changing the rules", async () => {
	const { catalog, zImage, seedream } = fixture();
	zImage.billing.credits = 12;
	seedream.billing.resolution_credits["1.5K"] = 6.5;
	const feed = await collectPoyoPricing(source(JSON.stringify(catalog)).fetch, license);

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
		await expect(
			collectPoyoPricing(source(JSON.stringify(input.catalog)).fetch, license),
		).rejects.toThrow("catalog");
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
		const feed = await collectPoyoPricing(
			source(JSON.stringify(input.catalog)).fetch,
			license,
			(model) => gaps.push(model),
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
		const feed = await collectPoyoPricing(upstream.fetch, license);
		expect(feed.rates["z-image"]).toEqual({ kind: "unavailable" });
	}
});

test("rejects invalid commit provenance before fetching the raw URL", async () => {
	for (const sha of ["main", revision]) {
		const upstream = source(undefined, {
			[commitsUrl]: () =>
				Response.json([{ sha, commit: { committer: { date: "2026-02-30T00:00:00Z" } } }]),
		});
		await expect(collectPoyoPricing(upstream.fetch, license)).rejects.toThrow("commit provenance");
		expect(upstream.seen).toEqual([commitsUrl]);
	}
});

test("rejects a future path commit date before requesting the raw artifact", async () => {
	const future = new Date(Date.now() + 60_000).toISOString().replace(/\.\d{3}Z$/, "Z");
	const upstream = source(undefined, {
		[commitsUrl]: () => Response.json([{ sha: revision, commit: { committer: { date: future } } }]),
	});
	await expect(collectPoyoPricing(upstream.fetch, license)).rejects.toThrow("future");
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
		await expect(collectPoyoPricing(source(undefined, override).fetch, license)).rejects.toThrow(
			message,
		);
	}
});
