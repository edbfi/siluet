// Reviewed rules and overrides, each bound to the SHA-256 of the canonical schema it was checked
// against. A changed schema makes it stale: the construct it replaced is uncovered again, and
// the override no longer narrows the row. Overrides may only narrow.
import type { Body, ReviewedRule } from "./schema";

const ratios = ["1:1", "4:3", "3:4", "16:9", "9:16", "3:2", "2:3"];
const tier = (longEdge: number) => (longEdge <= 1024 ? "1K" : longEdge <= 2048 ? "2K" : "4K");

/**
 * flux-3-klein `size`: exactly `oneOf` [an enum of seven ratios, `pattern: ^\d+x\d+$`]. Siluet
 * sends canonical `WxH`. Catalog `ec73207`, unchanged since `747e5d7`: "Custom dimensions must
 * each be 256-4096, divisible by 16, and accompanied by an explicit matching resolution";
 * `resolution`: "For custom dimensions, the long edge selects the tier: at most 1024 = 1K,
 * above 1024 through 2048 = 2K, above 2048 through 4096 = 4K."
 */
function fluxKleinSize(value: unknown, body: Body) {
	if (typeof value !== "string") return "must be a string";
	if (ratios.includes(value)) return null;
	const match = /^(\d+)x(\d+)$/.exec(value);
	if (!match) return "is neither a listed ratio nor WIDTHxHEIGHT";
	// Siluet sends canonical WxH only.
	if (/^0|x0/.test(value)) return "has a side with a leading zero";
	const [width, height] = [Number(match[1]), Number(match[2])];
	if ([width, height].some((side) => side < 256 || side > 4096))
		return "has a side outside 256-4096";
	if ([width, height].some((side) => side % 16)) return "has a side not divisible by 16";
	if (body.resolution !== tier(Math.max(width, height)))
		return `needs resolution ${tier(Math.max(width, height))}`;
	return null;
}

const fluxKleinQuote =
	"Custom dimensions must each be 256-4096, divisible by 16, and accompanied by an explicit matching resolution.";

// The OpenAPI input's `size` is a `oneOf` of the same ratios and a described WIDTHxHEIGHT
// branch, with the same sentence, so the rule replaces both sources' constructs.
const fluxKlein = (
	model: string,
	source: "catalog" | "rest",
	schemaSha256: string,
): ReviewedRule => ({
	id: `${model}-size-${source}`,
	model,
	source,
	schemaSha256,
	field: "size",
	constructs: ["oneOf"],
	quote: fluxKleinQuote,
	check: fluxKleinSize,
});

export const reviewedRules: readonly ReviewedRule[] = [
	fluxKlein(
		"flux-3-klein",
		"catalog",
		"6b2cc771fdd5b78bc6d461bf3fa7c33fd3414d3843046d43554b4aeb8224593e",
	),
	fluxKlein(
		"flux-3-klein",
		"rest",
		"d0a89b2f6d4267e2016874ea9216bd38a51603beef3eea29cb3bc297e4cfb0c5",
	),
	fluxKlein(
		"flux-3-klein-edit",
		"catalog",
		"d9cc07c5812aa2771d9804ef771e0608172db1a5acfcf77ca2883bfe5320ce57",
	),
	fluxKlein(
		"flux-3-klein-edit",
		"rest",
		"100d9e6596b34decbca5f04ef3481b341841fef3ca946b2aabbcd3b5a3f9c2c4",
	),
];

/** A reviewed narrowing of one option's documented domain on one operation. */
export type ReviewedOverride = {
	readonly model: string;
	readonly operation: string;
	readonly field: string;
	readonly schemaSha256: string;
	/** Values removed from the documented domain, because the provider says they do not apply. */
	readonly excludes: readonly unknown[];
	readonly quote: string;
};

const nanoBanana2 = "08d834071d42fee8adfe8b1e46f4b35b5ba499025ddb2f59dc3e8d6bff6800b4";
const nanoBanana2New = "5d0437e8c9ea8b71bff776cbec0f3ff9dd062c622e34614d5d972abc32f4a663";
const proAuto = "Nano Banana Pro also supports `auto`";
const officialSizes =
	"`nano-banana-2-official` also supports `auto`, `4:1`, `1:4`, `8:1`, and `1:8`";
const officialResolution = "`nano-banana-2-official` also supports `0.5K`";
// A model-scoped qualifier in a shared schema applies to every model on that hash, edits included.
const sharedOverrides = (
	model: string,
	operation: string,
	schemaSha256: string,
	narrowings: [field: string, excludes: unknown[], quote: string][],
): ReviewedOverride[] =>
	narrowings.map(([field, excludes, quote]) => ({
		model,
		operation,
		field,
		schemaSha256,
		excludes,
		quote,
	}));
const flux2 = "939f96ce680b4be57af2f2e1593d90db12753ca2836bbbf297ae94e8dba6fccc";
const firstInputImage = "Use 'auto' to automatically detect based on first input image";

export const reviewedOverrides: readonly ReviewedOverride[] = [
	...sharedOverrides("nano-banana-2", "text-to-image", nanoBanana2, [["size", ["auto"], proAuto]]),
	...sharedOverrides("nano-banana-2-edit", "reference-image-edit", nanoBanana2, [
		["size", ["auto"], proAuto],
	]),
	...(["nano-banana-2-new", "nano-banana-2-new-edit"] as const).flatMap((model) =>
		sharedOverrides(
			model,
			model === "nano-banana-2-new" ? "text-to-image" : "reference-image-edit",
			nanoBanana2New,
			[
				["resolution", ["0.5K"], officialResolution],
				["size", ["auto", "4:1", "1:4", "8:1", "1:8"], officialSizes],
			],
		),
	),
	{
		model: "kling-o3-image",
		operation: "text-to-image",
		field: "size",
		schemaSha256: "26cc8c186945c63718b5f9920dcb66caf693027fcb69d45c317d0bba5a5ce8b4",
		excludes: ["auto"],
		quote: "`auto` is only supported when `model` is `kling-o3-image-edit`",
	},
	// Text-to-image sends no input image for `auto` to follow.
	...["flux-2-flex", "flux-2-pro"].map((model) => ({
		model,
		operation: "text-to-image",
		field: "size",
		schemaSha256: flux2,
		excludes: ["auto"],
		quote: firstInputImage,
	})),
	{
		model: "qwen-image-2.1",
		operation: "text-to-image",
		field: "size",
		schemaSha256: "68295d1b10b36dafd8fd5a1790d4fa76c8e79aa4fc94637686541a60501e02c1",
		excludes: ["auto"],
		quote: "auto requires at least one reference image",
	},
	{
		model: "seedream-5.5",
		operation: "text-to-image",
		field: "size",
		schemaSha256: "5aed72c999e5a0e16e6755d6c0e1df2660c2ef363cd3fdd10913c96741edda44",
		excludes: ["auto"],
		quote: "auto applies to image editing and follows the reference images",
	},
	{
		model: "h3-max",
		operation: "text-to-video",
		field: "aspect_ratio",
		schemaSha256: "a6ed2d836a9301a26981500d1632c33c902732776f8e24cb692f09c61f02b3d4",
		excludes: ["adaptive"],
		quote: "Text mode defaults to 16:9 and does not accept adaptive.",
	},
];

/**
 * A reviewed removal of one whole option from one operation, because a shared schema says the
 * field belongs to another model on the same hash. Like a value override, it only narrows.
 */
export type ReviewedFieldExclusion = {
	readonly model: string;
	readonly operation: string;
	readonly field: string;
	readonly schemaSha256: string;
	readonly quote: string;
};

const proOnly = "Nano Banana Pro only.";
const officialOnly = "Nano Banana 2 Official only.";
export const reviewedFieldExclusions: readonly ReviewedFieldExclusion[] = [
	...(["nano-banana-2", "nano-banana-2-edit"] as const).flatMap((model) =>
		["enable_web_search", "output_format"].map((field) => ({
			model,
			operation: model === "nano-banana-2" ? "text-to-image" : "reference-image-edit",
			field,
			schemaSha256: nanoBanana2,
			quote: proOnly,
		})),
	),
	...(["nano-banana-2-new", "nano-banana-2-new-edit"] as const).flatMap((model) =>
		["seed", "output_format"].map((field) => ({
			model,
			operation: model === "nano-banana-2-new" ? "text-to-image" : "reference-image-edit",
			field,
			schemaSha256: nanoBanana2New,
			quote: officialOnly,
		})),
	),
];

/**
 * How a model-scoped qualifier ("only", "also supports") in a schema several models share is
 * resolved: by exclusions on the named models, as true of every model on the hash, or by the
 * later slice that owns the operation it qualifies, which resolves it there.
 */
export type QualifierDisposition = {
	readonly schemaSha256: string;
	/** The description's path in the schema, such as `properties/size`. */
	readonly path: string;
	/** The qualifier's words, a substring of the description. */
	readonly quote: string;
	readonly applies:
		| { readonly to: "narrowed"; readonly models: readonly string[] }
		| { readonly to: "every-model"; readonly reason: string }
		| { readonly to: "slice"; readonly slice: string; readonly reason: string };
};

const narrowed = (
	schemaSha256: string,
	path: string,
	quote: string,
	models: readonly string[],
): QualifierDisposition => ({ schemaSha256, path, quote, applies: { to: "narrowed", models } });
const every = (
	schemaSha256: string,
	path: string,
	quote: string,
	reason: string,
): QualifierDisposition => ({ schemaSha256, path, quote, applies: { to: "every-model", reason } });
const later = (
	schemaSha256: string,
	path: string,
	quote: string,
	slice: string,
	reason: string,
): QualifierDisposition => ({ schemaSha256, path, quote, applies: { to: "slice", slice, reason } });

const klingO3Auto = "`auto` is only supported when `model` is `kling-o3-image-edit`";
const flux3 = "aed6ace1167e8e0ca5b9b7d6ef919d925c7bc992e64dc8bbccbe963dde13a95c";
const veoOfficial = "0637c6a9e37f88c8f3c50c25b19bf27799c4e82942861b5fe3086d6442f7b841";
const hailuo02 = "fdc2e5aebec6f3cfc3b7ea0ca3719c9281a422def88ba4699cb0250f139e6fc1";

export const qualifierDispositions: readonly QualifierDisposition[] = [
	// Images (G4 narrows its own rows; edits and closed-schema rows wait for G5 and G6).
	...["enable_web_search", "output_format"].map((field) =>
		narrowed(nanoBanana2, `properties/${field}`, proOnly, ["nano-banana-2", "nano-banana-2-edit"]),
	),
	narrowed(nanoBanana2, "properties/size", proAuto, ["nano-banana-2", "nano-banana-2-edit"]),
	...["seed", "output_format"].map((field) =>
		narrowed(nanoBanana2New, `properties/${field}`, officialOnly, [
			"nano-banana-2-new",
			"nano-banana-2-new-edit",
		]),
	),
	narrowed(nanoBanana2New, "properties/resolution", officialResolution, [
		"nano-banana-2-new",
		"nano-banana-2-new-edit",
	]),
	narrowed(nanoBanana2New, "properties/size", officialSizes, [
		"nano-banana-2-new",
		"nano-banana-2-new-edit",
	]),
	narrowed(
		"26cc8c186945c63718b5f9920dcb66caf693027fcb69d45c317d0bba5a5ce8b4",
		"properties/size",
		klingO3Auto,
		["kling-o3-image"],
	),
	narrowed(
		"09be1f794c0bc319d6cb20d10c4efeef1a647763989729f138e898819b946343",
		"properties/size",
		klingO3Auto,
		["kling-o3-image"],
	),
	every(
		"c4276e0f15562652e10d52e884b3747a6cbe2634ed013b8865e9d6aef1f9a330",
		"properties/resolution",
		"applies only to",
		"a billing note on the 4K tier, the same for generation and edit",
	),
	every(
		"137c5f6682d15a8181f2f287740779b4ee0017e0edf987efef40fbe9b25f2d6e",
		"properties/output_format",
		"gif is text-to-image only",
		"Flare and Sunburst share it; gif is never offered",
	),
	every(
		"722e20de1fe41ebdd636a8eef58925556a5fb78438388668bf81efca5230e2b7",
		"properties/output_compression",
		"Only allowed when output_format is jpeg or webp",
		"a cross-field rule on Flare and Sunburst alike (G6)",
	),
	later(
		"cd875db0230a102f2a6c5409dc30165973e7225fc4aac8953858113aa3b859c7",
		"properties/image_urls",
		"Only the first image is used",
		"G5",
		"applies to edits",
	),
	later(
		"43b01090d5928aa2cad963a49e9a17cd4d4f8f9dccce4ceb1caefb1fbb671813",
		"properties/image_urls",
		"Required for seedream-5.0-flash-edit only",
		"G5",
		"applies to edits; text-to-image sends no image_urls",
	),
	later(
		"e420a101c689154810200e98c3f55b2498e1af3a5c89fe1fcf4ebb5771038778",
		"properties/mode",
		"Image to vector only",
		"P3 · GIF and SVG output",
		"applies to image-to-vector",
	),
	// Video (G7 and later own these operations).
	later(veoOfficial, "properties/duration", "supports 8 seconds only", "G7", "per-mode durations"),
	later(veoOfficial, "properties/image_urls", "supports duration 8 only", "G8", "frame modes"),
	later(
		"41083bcfaca4aca4ee5f3bf539ba70708ffadecc236288458f26dead7166add8",
		"properties/image_urls",
		"wan2.6-image-to-video only",
		"G8",
		"applies to image-to-video",
	),
	later(
		"41083bcfaca4aca4ee5f3bf539ba70708ffadecc236288458f26dead7166add8",
		"properties/video_urls",
		"wan2.6-video-to-video only",
		"P3 · source-video operations on Poyo.ai",
		"applies to video-to-video",
	),
	later(
		"6778c00251972c2504f27559295ad61e7905dd10da1b18a2a0bd3e1ad98a2804",
		"properties/end_image_url",
		"only supported by kling-1.6/pro",
		"G8",
		"applies to first-and-last-frame video",
	),
	later(
		"82119d2525581cc169f1f42706c599bd265cd40d8db492f5fcd3315b107473c3",
		"properties/end_image_url",
		"Only supported by kling-2.1/pro",
		"G8",
		"applies to first-and-last-frame video",
	),
	later(
		"9964baaeadb18556a7291ad8f3b4340ccbabf2d3eacf85f5d6570faf63c93225",
		"properties/kling_elements",
		"Only allowed in `reference-to-video`",
		"G8b",
		"applies to reference-to-video",
	),
	every(
		"9c7e19355c63b53b8ea70530cca46d6069ae7787a2d3b0a832ee1ac345b307a3",
		"properties/image_urls",
		"only 1 image allowed",
		"both Wan Animate models take one image",
	),
	later(
		flux3,
		"properties/image_urls",
		"image-to-video and first-last-frame-to-video only",
		"G8",
		"applies to frame modes",
	),
	later(
		flux3,
		"properties/keyframes",
		"flux-3/keyframes-to-video only",
		"P3 · positioned, last-frame and multi keyframes",
		"applies to positioned keyframes",
	),
	later(
		flux3,
		"properties/keyframes/items/properties/frame_index",
		"flux-3/keyframes-to-video only",
		"P3 · positioned, last-frame and multi keyframes",
		"applies to positioned keyframes",
	),
	later(
		flux3,
		"properties/keyframes/items/properties/image_url",
		"flux-3/keyframes-to-video only",
		"P3 · positioned, last-frame and multi keyframes",
		"applies to positioned keyframes",
	),
	later(
		flux3,
		"properties/video_url",
		"flux-3/extend-video only",
		"P3 · video extension",
		"applies to video extension",
	),
	every(
		"c3a887caedac099bbc8bb610f89ddfb0f8172fce381674c8c36b5766dcd19979",
		"properties/image_urls",
		"Only one image is supported",
		"both Kling 3.0 Turbo tiers take one first frame",
	),
	later(
		"f852ca467199b1b66f484e41a65210bbddae2722ccbe1db856fae81557652a0f",
		"properties/image_urls",
		"provide only the start frame URL",
		"G8",
		"applies to frame modes",
	),
	later(
		"ee91018138682f3b7193d282ab79ef0365024e94ab4483473a9fedc550119ae0",
		"properties/resolution",
		"`seedance-2-fast` supports `480p` and `720p` only",
		"G7",
		"narrows seedance-2-fast",
	),
	later(hailuo02, "properties/duration", "(hailuo-02 only)", "G7", "narrows hailuo-02-pro"),
	later(
		hailuo02,
		"properties/end_image_url",
		"(image-to-video only)",
		"G8",
		"applies to first-and-last-frame video",
	),
	later(
		hailuo02,
		"properties/resolution",
		"(hailuo-02 image-to-video only)",
		"G8",
		"applies to image-to-video",
	),
];

/** Where a one-output quote stands, bound to the digest of the source it was read from. */
export type OutputSource =
	/** The model's OpenAPI spec's `info.description`, at the spec's manifest SHA-256. */
	| { readonly kind: "openapi-info"; readonly spec: string; readonly sha256: string }
	/** A model page recorded in page-reviews.json, at its Markdown SHA-256. */
	| { readonly kind: "page"; readonly url: string; readonly sha256: string };

/**
 * Evidence that one mode of a row without a count field returns one output (spec, "One output
 * per request"). The quote must stand in its bound source; a changed digest makes the note stale.
 */
export type OutputNote = {
	readonly model: string;
	readonly operation: string;
	readonly quote: string;
	readonly source: OutputSource;
};

const openapiInfo = (path: string, sha256: string) =>
	({ kind: "openapi-info", spec: `/api-manual/image-series/${path}.json`, sha256 }) as const;

// The eleven rows the G4 plan lists as conditional on their model page stay without a note:
// the two pinned pages (seedream-5.0-pro, nano-banana-2-lite) state no output count, and the
// other nine pages are not pinned (page-reviews.json).
export const outputNotes: readonly OutputNote[] = [
	{
		model: "qwen-image-2.1",
		operation: "text-to-image",
		quote: "The Qwen Image 2.1 API generates one image from text",
		source: openapiInfo(
			"qwen-image-2-1",
			"93a072aed810078eac0fc927c7a81298bacfdeaaeaba51e512dff6380d6919aa",
		),
	},
	{
		model: "seedream-5.0-flash",
		operation: "text-to-image",
		quote: "The Seedream 5.0 Flash API generates one image from text",
		source: openapiInfo(
			"seedream-5-0-flash",
			"767b459336c42f30a351e70ec65fbb3a0e0536f4bc147e953416b48dabab2e1b",
		),
	},
];
