import type { SaveLimit } from "./save-profile";

// One Poyo.ai `POST /api/generate/submit` video contract: Bearer JSON `{model, input}`.
// A descriptor lists the reviewed inputs of one model in that family as data.
export type PoyoVideoField =
	| Readonly<{ kind: "int"; min: number; max: number }>
	| Readonly<{ kind: "enum"; values: readonly string[] }>;
export type PoyoInputValue = string | number | boolean;

export type PoyoVideoDescriptor = Readonly<{
	model: string;
	label: string;
	family: string;
	operation: "text-to-video";
	defaults: Readonly<Record<string, PoyoInputValue>>;
	fields: Readonly<Record<string, PoyoVideoField>>;
	/** The D4 field, always sent as the JSON boolean `false`. */
	d4Field: "enable_safety_checker";
	/** Review appends the Save limit's disclosure after these. */
	disclosures: readonly string[];
	/** The documented maximum output, quoted with its source; null keeps the mode Review-only. */
	save: SaveLimit | null;
	/** The model's entry in the Poyo v2 rate feed. */
	rateKey: string;
}>;

export type PoyoVideoBody = { model: string; input: Record<string, PoyoInputValue> };

function accepts(field: PoyoVideoField, value: unknown) {
	return field.kind === "int"
		? typeof value === "number" &&
				Number.isInteger(value) &&
				value >= field.min &&
				value <= field.max
		: typeof value === "string" && field.values.includes(value);
}

/** The reviewed options of an exact draft: the prompt plus every field, and nothing else. */
export function poyoVideoOptions(descriptor: PoyoVideoDescriptor, draft: object) {
	const names = Object.keys(descriptor.fields);
	const keys = Object.keys(draft);
	if (keys.length !== names.length + 1 || !keys.every((k) => k === "prompt" || names.includes(k)))
		return null;
	const options: Record<string, PoyoInputValue> = {};
	for (const name of names) {
		const value = (draft as Record<string, unknown>)[name];
		if (!accepts(descriptor.fields[name], value)) return null;
		options[name] = value as PoyoInputValue;
	}
	options[descriptor.d4Field] = false;
	return options;
}

export function poyoVideoBody(
	descriptor: PoyoVideoDescriptor,
	prompt: string,
	options: Record<string, PoyoInputValue>,
): PoyoVideoBody {
	return { model: descriptor.model, input: { prompt, ...options } };
}
