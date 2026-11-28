// The composer draft and wire request of a Queue-eligible derived Poyo.ai text-to-image row
// (poyo-queue.json). The browser and the server validate the same draft against the same row:
// strict keys, offered values only, the row's combinations and its prompt limits. The server
// then re-validates the serialized body against both pinned schemas.
import type { QueueField, QueueRow } from "../media-catalog/queue-row";

type Json = null | boolean | number | string | Json[] | { [key: string]: Json };

export type DerivedDraft = {
	model: string;
	operation: "text-to-image";
	prompt: string;
	/** One value per field the row sends; an empty optional field is left out. */
	options: Record<string, Json>;
};

type Errors = Partial<Record<string, string>>;
export type DerivedValidation = { ok: true; draft: DerivedDraft } | { ok: false; errors: Errors };

const submitUrl = "https://api.poyo.ai/api/generate/submit";
const draftKeys = ["model", "operation", "prompt", "options"];

const plain = (value: unknown): value is Record<string, unknown> =>
	typeof value === "object" &&
	value !== null &&
	(Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null);

/** A field's wire name as Review and errors say it: `output_format` is "output format". */
export const fieldLabel = (wire: string) => wire.replaceAll("_", " ");

/** A new draft on the row's preselected values, with an empty prompt. */
export function createDerivedDraft(row: QueueRow, prompt = ""): DerivedDraft {
	return {
		model: row.key.model,
		operation: row.key.operation,
		prompt,
		options: Object.fromEntries(
			row.fields
				.filter((field) => !field.optional)
				.map((field) => [field.wire, field.preselect as Json]),
		),
	};
}

/** Why one field's value is refused, or null. */
function fieldError(field: QueueField, value: unknown) {
	const label = fieldLabel(field.wire);
	if (field.kind === "enum")
		return field.values?.some((offered) => offered === value)
			? null
			: `Choose a ${label} this model offers.`;
	if (field.kind === "boolean")
		return typeof value === "boolean" ? null : `Choose on or off for ${label}.`;
	const whole =
		typeof value === "number" &&
		Number.isSafeInteger(value) &&
		(field.min === undefined || value >= field.min) &&
		(field.max === undefined || value <= field.max);
	if (whole) return null;
	return field.wire === "seed"
		? "Use a whole number seed, or leave it empty."
		: `Use a whole number from ${field.min ?? "any"} to ${field.max ?? "any"} for ${label}.`;
}

/** Validates a draft for one queue row, in the browser and on the server alike. */
export function validateDerivedDraft(row: QueueRow, value: unknown): DerivedValidation {
	if (
		!plain(value) ||
		Object.keys(value).some((key) => !draftKeys.includes(key)) ||
		value.model !== row.key.model ||
		value.operation !== row.key.operation ||
		typeof value.prompt !== "string" ||
		!plain(value.options)
	)
		return { ok: false, errors: { draft: "Choose an image model and its options again." } };
	const options = value.options;
	const wires = row.fields.map((field) => field.wire);
	if (Object.keys(options).some((key) => !wires.includes(key)))
		return { ok: false, errors: { options: "Use only this model's options." } };
	const errors: Errors = {};
	const prompt = value.prompt.trim();
	const length = Array.from(prompt).length;
	const { min, max } = row.prompt;
	if (!prompt || length < min || length > max)
		errors.prompt = `Use ${min.toLocaleString("en-US")}–${max.toLocaleString("en-US")} characters for this model.`;
	const chosen: Record<string, Json> = {};
	for (const field of row.fields) {
		if (!Object.hasOwn(options, field.wire)) {
			if (!field.optional) errors[field.wire] = fieldError(field, undefined) as string;
			continue;
		}
		const error = fieldError(field, options[field.wire]);
		if (error) errors[field.wire] = error;
		else chosen[field.wire] = options[field.wire] as Json;
	}
	for (const { when, refuses } of row.combinations) {
		const applies = Object.entries(when).every(([wire, at]) => chosen[wire] === at);
		if (!applies) continue;
		for (const [wire, values] of Object.entries(refuses))
			if (values.some((refused) => refused === chosen[wire]) && !errors[wire]) {
				const [[whenWire, whenValue]] = Object.entries(when);
				errors[wire] =
					`This model does not offer ${String(chosen[wire])} with a ${String(whenValue)} ${fieldLabel(whenWire)}.`;
			}
	}
	if (Object.keys(errors).length) return { ok: false, errors };
	return {
		ok: true,
		draft: { model: row.key.model, operation: row.key.operation, prompt, options: chosen },
	};
}

/**
 * The exact request a validated draft sends: its options in field order, `n: 1` where the row
 * has a count field, and the D4 field as `false`. No defaults are added.
 */
export function buildDerivedRequest(row: QueueRow, draft: DerivedDraft) {
	const options = Object.fromEntries(
		row.fields
			.filter((field) => Object.hasOwn(draft.options, field.wire))
			.map((field) => [field.wire, draft.options[field.wire]]),
	);
	return {
		method: "POST",
		url: submitUrl,
		body: {
			model: row.key.model,
			input: {
				prompt: draft.prompt,
				...options,
				...(row.count === 1 && { n: 1 }),
				enable_safety_checker: false,
			} as { prompt: string; enable_safety_checker: false } & Record<string, Json>,
		},
	} as const;
}
