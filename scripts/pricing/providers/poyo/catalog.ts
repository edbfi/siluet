import { isCreditRate } from "../../../../src/lib/shared/pricing/decimal.ts";
import { isPricingRecord, type PricingFeed } from "../../../../src/lib/shared/pricing/feed.ts";
import type { PerSecondRate } from "../../../../src/lib/shared/pricing/poyo-feed.ts";
import h3Contract from "./h3-max-contract.json";

const numberToken = Symbol("JSON number token");
const resolutions = ["1K", "1.5K", "2K"] as const;
const models = ["z-image", "seedream-5.5", "h3-max"] as const;
// Siluet offers these H3 resolutions. 1080p stays pending qualification.
const h3Resolutions = ["480p", "768p"] as const;

type Model = (typeof models)[number];
type Unavailable = { kind: "unavailable" };
type Rates = PricingFeed["rates"] & { "h3-max": PerSecondRate | Unavailable };
type ModelRate<T extends Model> = Exclude<Rates[T], Unavailable>;
export type ReportGap = (model: Model, reason: string) => void;

function hasKeys(value: unknown, keys: readonly string[]): value is Record<string, unknown> {
	return (
		isPricingRecord(value) &&
		Object.keys(value).length === keys.length &&
		keys.every((key) => Object.hasOwn(value, key))
	);
}

function hasValues(value: unknown, expected: readonly string[]): boolean {
	return (
		Array.isArray(value) &&
		value.length === expected.length &&
		expected.every((member) => value.includes(member))
	);
}

class ModelDrift extends Error {}

function numberSource(value: unknown): unknown {
	if (typeof value === "object" && value !== null && numberToken in value) {
		return value[numberToken];
	}
}

function credits(value: unknown): string {
	const source = numberSource(value);
	if (!isCreditRate(source)) {
		throw new ModelDrift("The rate is outside the reviewed positive decimal format.");
	}
	return source.includes(".") ? source.replace(/0+$/, "").replace(/\.$/, "") : source;
}

// Reviewed inputs and billing at the pinned catalog revision:
// https://github.com/PoyoAPI/poyo-devtools/blob/ec7320720913a55f955e1bf6a651e9c38bd356c5/artifacts/capability-catalog.json
const modelFields = [
	"billing",
	"category",
	"description",
	"examples",
	"execution_mode",
	"input_schema",
	"model_id",
	"output_schema",
	"service_type",
	"status",
	"supported_protocols",
	"supports_callback",
	"supports_streaming",
	"tags",
	"title",
	"tool_name",
];

const inputDescriptions = {
	"z-image":
		"Input parameters for generation. `size` is required for text-to-image. When `image_urls` is present, the request is routed to image editing automatically and `size` becomes optional.",
	"seedream-5.5": "Generate one image. With image_urls, edit or combine the reference images.",
};

const referenceItem = { type: "string", format: "uri" };
const safetyChecker = { type: "boolean", default: true };
const commonRatios = ["1:1", "4:3", "3:4", "16:9", "9:16"];

const inputSchemas = {
	"z-image": {
		type: "object",
		required: ["prompt"],
		properties: {
			prompt: { type: "string", maxLength: 1000 },
			size: { type: "string", enum: commonRatios },
			image_urls: { type: "array", items: referenceItem, maxItems: 1 },
			enable_safety_checker: safetyChecker,
		},
	},
	"seedream-5.5": {
		type: "object",
		required: ["prompt"],
		additionalProperties: false,
		properties: {
			prompt: { type: "string", maxLength: 5000, minLength: 5 },
			size: { type: "string", enum: [...commonRatios, "3:2", "2:3", "21:9", "auto"] },
			image_urls: { type: "array", items: referenceItem, minItems: 1, maxItems: 10 },
			enable_safety_checker: safetyChecker,
			resolution: { type: "string", enum: resolutions, default: "2K" },
			background: { type: "string", enum: ["auto", "transparent", "opaque"], default: "auto" },
			output_format: { type: "string", enum: ["png", "jpeg"], default: "png" },
		},
	},
};

type SchemaValue =
	| string
	| number
	| boolean
	| null
	| readonly SchemaValue[]
	| { readonly [key: string]: SchemaValue | undefined };

function matchesInputSchema(value: unknown, expected: SchemaValue, propertyNames = false): boolean {
	if (typeof expected === "number") return numberSource(value) === String(expected);
	if (Array.isArray(expected)) {
		// String lists are unordered sets. Schema lists such as allOf keep their order.
		if (expected.every((item) => typeof item === "string")) return hasValues(value, expected);
		return (
			Array.isArray(value) &&
			value.length === expected.length &&
			expected.every((item, index) => matchesInputSchema(value[index], item))
		);
	}
	if (expected === null || typeof expected !== "object") return value === expected;
	if (!isPricingRecord(value)) return false;

	// Annotations can change without affecting the request constraints. The
	// top-level operation description is checked separately.
	const keywords = Object.keys(value).filter(
		(key) => propertyNames || (key !== "description" && key !== "example" && key !== "examples"),
	);
	const expectedEntries = Object.entries(expected);
	return (
		keywords.length === expectedEntries.length &&
		expectedEntries.every(
			([key, schema]) =>
				Object.hasOwn(value, key) &&
				schema !== undefined &&
				matchesInputSchema(value[key], schema, !propertyNames && key === "properties"),
		)
	);
}

function reviewedInputs(row: Record<string, unknown>, model: Model) {
	if (
		!Object.keys(row).every((key) => modelFields.includes(key)) ||
		row.category !== { "z-image": "text2img", "seedream-5.5": "image", "h3-max": "video" }[model] ||
		row.service_type !== "generate" ||
		row.status !== "stable" ||
		row.execution_mode !== "async"
	) {
		throw new ModelDrift("The catalog model fields, route, or availability changed.");
	}
	const schema = row.input_schema;
	if (model === "h3-max") {
		if (!matchesInputSchema(schema, h3Contract.input_schema))
			throw new ModelDrift("The H3 Max request options changed.");
		return;
	}
	if (
		!isPricingRecord(schema) ||
		schema.description !== inputDescriptions[model] ||
		!matchesInputSchema(schema, inputSchemas[model])
	) {
		throw new ModelDrift("The catalog request options or reference limits changed.");
	}
}

function zImageRate(row: Record<string, unknown>): ModelRate<"z-image"> {
	const billing = row.billing;
	if (
		!hasKeys(billing, ["type", "unit", "credits", "input_credits", "output_credits"]) ||
		billing.type !== "fixed" ||
		billing.unit !== "request" ||
		billing.input_credits !== null ||
		billing.output_credits !== null
	) {
		throw new ModelDrift("The catalog Z-Image per-request billing rule changed.");
	}
	return { kind: "per-request", credits: credits(billing.credits) };
}

function seedreamRate(row: Record<string, unknown>): ModelRate<"seedream-5.5"> {
	const billing = row.billing;
	if (
		!hasKeys(billing, [
			"type",
			"unit",
			"credits",
			"input_credits",
			"output_credits",
			"formula",
			"parameters",
			"resolution_credits",
			"input_image_credits",
		]) ||
		billing.type !== "parameterized" ||
		billing.unit !== "image" ||
		billing.credits !== null ||
		billing.input_credits !== null ||
		billing.output_credits !== null ||
		billing.formula !==
			"resolution_credits[resolution] + reference_image_count * input_image_credits" ||
		!hasKeys(billing.parameters, ["resolution", "reference_image_count"]) ||
		billing.parameters.resolution !== "1K, 1.5K or 2K (defaults to 2K)" ||
		billing.parameters.reference_image_count !== "number of image_urls (0 for text-to-image)" ||
		!hasKeys(billing.resolution_credits, resolutions)
	) {
		throw new ModelDrift("The catalog Seedream per-image or reference billing rule changed.");
	}
	return {
		kind: "per-image-with-references",
		resolutions: {
			"1K": credits(billing.resolution_credits["1K"]),
			"1.5K": credits(billing.resolution_credits["1.5K"]),
			"2K": credits(billing.resolution_credits["2K"]),
		},
		perReference: credits(billing.input_image_credits),
	};
}

// Reviewed text-mode rule at the pinned revision: duration × per-second rate, with zero
// reference tokens outside reference mode. Siluet publishes only the resolutions it offers.
function h3MaxRate(row: Record<string, unknown>): ModelRate<"h3-max"> {
	const billing = row.billing;
	if (!isPricingRecord(billing)) throw new ModelDrift("The catalog H3 Max billing is missing.");
	const { resolution_credits_per_second: rates, ...rule } = billing;
	if (
		!matchesInputSchema(rule, h3Contract.billingRule) ||
		!hasKeys(rates, [...h3Resolutions, "1080p"])
	)
		throw new ModelDrift("The catalog H3 Max per-second billing rule changed.");
	const resolutions: Record<string, string> = {};
	for (const resolution of h3Resolutions) resolutions[resolution] = credits(rates[resolution]);
	return { kind: "per-second-by-resolution", resolutions };
}

function catalogRows(text: string): Map<string, Record<string, unknown>> {
	let catalog: unknown;
	try {
		// Preserve the source token so JSON.parse cannot silently round a rate.
		// https://developer.mozilla.org/en-US/docs/Web/JavaScript/Reference/Global_Objects/JSON/parse
		catalog = JSON.parse(text, (_key, value: unknown, context?: { source?: string }) =>
			typeof value === "number" ? { [numberToken]: context?.source } : value,
		);
	} catch {
		throw new Error("PoYo catalog contains invalid JSON.");
	}

	// The pinned artifact has 266 unique model IDs. A drop below 200 needs review
	// even if the new file still claims to contain a complete, unpaginated catalog.
	if (
		!hasKeys(catalog, ["schema_version", "has_more", "next_cursor", "items"]) ||
		typeof catalog.schema_version !== "string" ||
		!/^v1-[a-f0-9]{12}$/.test(catalog.schema_version) ||
		catalog.has_more !== false ||
		catalog.next_cursor !== null ||
		!Array.isArray(catalog.items) ||
		catalog.items.length < 200
	) {
		throw new Error("PoYo catalog is incomplete or its envelope changed.");
	}
	const rows = new Map<string, Record<string, unknown>>();
	for (const item of catalog.items) {
		if (
			!isPricingRecord(item) ||
			typeof item.model_id !== "string" ||
			!/^[a-z0-9][a-z0-9._:/-]{0,127}$/i.test(item.model_id) ||
			rows.has(item.model_id)
		) {
			throw new Error("PoYo catalog contains an invalid or duplicate model ID.");
		}
		// Every row in the pinned artifact has these three nonempty objects.
		// Validate their presence here and review known models' semantics separately.
		for (const section of [item.input_schema, item.output_schema, item.billing]) {
			if (!isPricingRecord(section) || Object.keys(section).length === 0) {
				throw new Error("PoYo catalog contains an incomplete model row.");
			}
		}
		rows.set(item.model_id, item);
	}
	return rows;
}

export function normalizeRates(text: string, reportGap?: ReportGap): Rates {
	const rows = catalogRows(text);
	function rateFor<Rate>(
		model: Model,
		extract: (row: Record<string, unknown>) => Rate,
	): Rate | { kind: "unavailable" } {
		try {
			const row = rows.get(model);
			if (!row) throw new ModelDrift("The model is missing from the complete catalog.");
			reviewedInputs(row, model);
			return extract(row);
		} catch (error) {
			if (!(error instanceof ModelDrift)) throw error;
			reportGap?.(model, error.message);
			return { kind: "unavailable" };
		}
	}
	return {
		"z-image": rateFor("z-image", zImageRate),
		"seedream-5.5": rateFor("seedream-5.5", seedreamRate),
		"h3-max": rateFor("h3-max", h3MaxRate),
	};
}
