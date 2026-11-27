// bun run catalog:coverage: expands every documented ledger key and every creator option of
// the derived Poyo.ai rows, gives each exactly one state and prints the tag-blocking count.
// `--write` regenerates the generated sections of docs/catalog-engine-inventory.md.
import { readFileSync, writeFileSync } from "node:fs";
import ledger from "../../docs/media-catalog.v1.json";
import type { D4State } from "../../src/lib/shared/media-catalog/filtering";
import { reviewedOverrides } from "../../src/lib/shared/media-catalog/rules";
import { type DerivedOption, type DerivedRow, type Domain, deriveRows } from "./derive";
import { type Offered, type VerifiedOptions, verifiedOptions } from "./verified";

type Provider = keyof typeof ledger.providers;
type Row = (typeof ledger.providers)[Provider]["rows"][number];

/** A documented row's primary route. An alias is the same contract and adds no key. */
export function primaryRoute(row: { route: string | null }) {
	return row.route;
}

export function catalogCoverage(provider: Provider) {
	const rows = ledger.providers[provider].rows as Row[];
	const ids = new Set(rows.flatMap((row) => row.ids));
	const unresolved = new Set(
		rows.filter((row) => row.contract !== "documented").flatMap((row) => row.ids),
	);
	let documentedOperations = 0;
	let prerequisiteBound = 0;
	let review = 0;
	let queue = 0;
	let partialOptions = 0;
	let addedSinceBaseline = 0;
	for (const row of rows) {
		const routeIds = primaryRoute(row) === null ? 0 : row.ids.length;
		documentedOperations += routeIds * row.operations.length;
		prerequisiteBound += routeIds * Object.keys(("requires" in row && row.requires) || {}).length;
		for (const name of Object.values(("support" in row && row.support) || {})) {
			const profile = ledger.supportProfiles[name as keyof typeof ledger.supportProfiles];
			if ("addedSinceBaseline" in profile && profile.addedSinceBaseline)
				addedSinceBaseline += row.ids.length;
			if (profile.review) review += row.ids.length;
			if (profile.queue) queue += row.ids.length;
			if (profile.optionCoverage === "partial") partialOptions += row.ids.length;
		}
	}
	return {
		discoveredIds: ids.size,
		unresolvedIds: unresolved.size,
		documentedOperations,
		prerequisiteBound,
		review,
		queue,
		partialOptions,
		addedSinceBaseline,
	};
}

export type Key = { provider: Provider; model: string; route: string; operation: string };

/** Every documented (provider, exact ID, primary route, operation). */
export function expandKeys(): (Key & { verified: boolean })[] {
	return (Object.keys(ledger.providers) as Provider[]).flatMap((provider) =>
		(ledger.providers[provider].rows as Row[]).flatMap((row) => {
			const route = primaryRoute(row);
			if (row.contract !== "documented" || route === null) return [];
			const support = ("support" in row && row.support) || {};
			return row.ids.flatMap((model) =>
				row.operations.map((operation) => ({
					provider,
					model,
					route,
					operation,
					verified: operation in support,
				})),
			);
		}),
	);
}

const p3 = (family: string) => `P3 · ${family}`;
const q = (question: string) => `Q · ${question}`;
// Where each documented operation is assigned, as the inventory records it.
const assignments: Record<Provider, Record<string, string>> = {
	poyo: {
		"text-to-image": "G4",
		"text-to-long-image": "G4 after G13 · Q: documented output bound",
		"reference-image-edit": "G5",
		"image-translation": "G5 · Q: target-language option",
		"image-background-removal": "G5",
		"reference-guided-long-image-generation": "G5 after G13 · Q: documented output bound",
		"text-to-video": "G7",
		"first-frame-to-video": "G8",
		"first-and-last-frame-to-video": "G8",
		"reference-to-video": "G8b",
		"image-reference-to-video": "G8b",
		"image-and-driving-audio-to-avatar-video": p3("audio and avatar inputs"),
		"character-video-and-driving-audio-to-avatar-video": p3("audio and avatar inputs"),
		"public-avatar-and-driving-audio-to-video": p3("audio and avatar inputs"),
		"public-avatar-and-text-to-video": p3("audio and avatar inputs"),
		"driving-audio-to-video": p3("audio and avatar inputs"),
		"text-to-gif": p3("GIF and SVG output"),
		"image-to-svg": p3("GIF and SVG output"),
		"text-to-svg": p3("GIF and SVG output"),
		"reference-guided-text-to-svg": p3("GIF and SVG output"),
		"image-layer-decomposition": p3("layer decomposition"),
		"mask-image-edit": p3("mask, markup and localized edits"),
		"localized-mask-image-edit": p3("mask, markup and localized edits"),
		"sequential-image-set": p3("multi-output and image sets"),
		"multi-shot-video-generation": p3("multi-shot"),
		"music-task-to-cover-image": p3("music and parent-task prerequisites"),
		"music-track-to-video": p3("music and parent-task prerequisites"),
		"positioned-keyframes-to-video": p3("positioned, last-frame and multi keyframes"),
		"last-frame-to-video": p3("positioned, last-frame and multi keyframes"),
		"video-edit": p3("source-video operations on Poyo.ai"),
		"image-and-motion-video-to-video": p3("source-video operations on Poyo.ai"),
		"video-to-video": p3("source-video operations on Poyo.ai"),
		"video-background-removal": p3("source-video operations on Poyo.ai"),
		"video-dubbing-and-subtitle-translation": p3("source-video operations on Poyo.ai"),
		"video-upscaling": p3("source-video operations on Poyo.ai"),
		"video-character-replacement": p3("source-video operations on Poyo.ai"),
		"video-extension": p3("video extension"),
	},
	toapis: {
		"text-to-image": "G10a",
		"text-to-webpage-image": "G10a after G13 · Q: documented output bound",
		"reference-image-edit": "G10b",
		"reference-guided-webpage-image": "G10b after G13 · Q: documented output bound",
		"reference-guided-ecommerce-image": "G10b after G13 · Q: documented output bound",
		"text-to-video": "G11a",
		"first-frame-to-video": "G11b",
		"first-and-last-frame-to-video": "G11b",
		"image-to-video": "G11b",
		"image-reference-to-video": "G11c",
		"video-reference-to-video": "G11c",
		"frame-and-image-reference-to-video": "G11c",
		"video-edit": "G11d",
		"file-reference-to-video": q("file and webpage references (accepted types, who fetches)"),
		"webpage-reference-to-video": q("file and webpage references (accepted types, who fetches)"),
		"draft-video-generation": p3("draft and draft-to-final chain"),
		"draft-to-final-video": p3("draft and draft-to-final chain"),
		"text-to-gif": p3("GIF and SVG output"),
		"image-to-gif": p3("GIF and SVG output"),
		"text-to-svg": p3("GIF and SVG output"),
		"image-layer-decomposition": p3("layer decomposition"),
		"mask-image-edit": p3("mask, markup and localized edits"),
		"markup-guided-image-edit": p3("mask, markup and localized edits"),
		"sequential-image-set": p3("multi-output and image sets"),
		"keyframes-to-video": p3("positioned, last-frame and multi keyframes"),
		"character-reference-to-video": p3("subjects and non-URL characters"),
		"subjects-to-video": p3("subjects and non-URL characters"),
		"video-extension": p3("video extension"),
		"multimodal-reference-to-video": p3("video or audio references"),
		"subject-and-media-reference-to-video": p3("video or audio references"),
		"image-and-video-reference-to-video": p3("video or audio references"),
		"subject-and-motion-reference-to-video": p3("video or audio references"),
		"image-and-audio-reference-to-video": p3("video or audio references"),
	},
};

/**
 * The slice, Phase 3 family or evidence question that holds one key. A closed-absent Poyo.ai
 * image row queues only after the acknowledgement, which lands with G6.
 */
export function assignment({ provider, route, operation }: Key, d4?: D4State) {
	if (provider === "toapis" && route.startsWith("POST /v1/midjourney/"))
		return p3("Midjourney actions");
	if (
		provider === "toapis" &&
		route.startsWith("POST /v1/videos") &&
		!route.startsWith("POST /v1/videos/generations")
	)
		return p3("ToAPIs /v1/videos envelope, remix and extend");
	const label = assignments[provider][operation];
	if (!label) throw new Error(`No assignment for ${provider} ${operation}.`);
	return provider === "poyo" && d4 === "closed-absent" && /^G[45]$/.test(label) ? "G6" : label;
}

export const coverageStates = [
	"verified",
	"contract-covered",
	"pending",
	"unsupported",
	"unknown",
] as const;
export type CoverageState = (typeof coverageStates)[number];
export type CoverageItem = Key & {
	/** The slice, Phase 3 family or question that holds the item's key. */
	slice: string;
	/** The option, and the values this item covers, or none for the key itself. */
	option?: string;
	values?: string;
	state: CoverageState;
	reason: string;
	/** The open question that records missing evidence: a spec number or an inventory label. */
	question?: number | string;
	evidence?: string;
	/** A documented value that a Siluet envelope excludes until the envelope is raised. */
	envelope?: true;
};

const range = (domain: Domain) =>
	domain.values
		? domain.values.map((value) => JSON.stringify(value)).join(", ")
		: domain.maxLength !== undefined
			? `up to ${domain.maxLength} characters`
			: `${domain.minimum ?? "…"}–${domain.maximum ?? "…"}`;

/** The documented domain of one option on one operation, after reviewed narrowings. */
function documented(row: DerivedRow, option: DerivedOption, operation: string): Domain {
	const excludes = reviewedOverrides
		.filter(
			(override) =>
				override.model === row.model &&
				override.operation === operation &&
				override.field === option.field &&
				override.schemaSha256 === row.catalog,
		)
		.flatMap(({ excludes }) => excludes);
	if (!excludes.length || !option.domain.values) return option.domain;
	return { ...option.domain, values: option.domain.values.filter((v) => !excludes.includes(v)) };
}

/** Why a verified composer does not offer the whole documented domain, or null when it does. */
export function offerGap(domain: Domain, offered: Offered | undefined) {
	if (!offered) return "not offered by the composer";
	if ("values" in offered) {
		const missing = (domain.values ?? []).filter((value) => !offered.values.includes(value));
		return missing.length
			? `composer omits ${missing.map((v) => JSON.stringify(v)).join(", ")}`
			: null;
	}
	if ("maxCodePoints" in offered)
		return domain.maxLength !== undefined && offered.maxCodePoints < domain.maxLength
			? `composer allows ${offered.maxCodePoints} of ${domain.maxLength} characters`
			: null;
	if ("maxBytes" in offered)
		return domain.maxLength !== undefined && offered.maxBytes < 4 * domain.maxLength
			? `Siluet's ${offered.maxBytes}-byte envelope excludes the documented ${domain.maxLength} characters`
			: null;
	const below = domain.minimum !== undefined && offered.minimum > domain.minimum;
	const above = domain.maximum !== undefined && offered.maximum < domain.maximum;
	return below || above
		? `composer offers ${offered.minimum}–${offered.maximum} of ${domain.minimum}–${domain.maximum}`
		: null;
}

const wholeNumbers = new Set<DerivedOption["kind"]>(["count", "integer"]);

/**
 * Values that only one source accepts beyond the shared domain, each its own unknown item with
 * question 8: enum values and the tails of `minimum`, `maximum` and `maxLength`. A bound one
 * source omits leaves that source unbounded.
 */
function disputedTails(option: DerivedOption): { values: string }[] {
	const { disputed, domain } = option;
	if (!disputed) return [];
	const tails: { values: string }[] = [];
	if (domain.values) {
		const values = [
			...new Set([...(disputed.catalog.values ?? []), ...(disputed.api.values ?? [])]),
		];
		const only = values.filter((value) => !domain.values?.includes(value));
		if (only.length) tails.push({ values: range({ values: only }) });
	}
	const sides = [disputed.catalog, disputed.api];
	const wider = (key: "minimum" | "maximum" | "maxLength", pick: (...n: number[]) => number) => {
		const bounds = sides.map((side) => side[key]);
		return bounds.some((bound) => bound === undefined) ? undefined : pick(...(bounds as number[]));
	};
	const whole = wholeNumbers.has(option.kind);
	if (domain.minimum !== undefined) {
		const low = wider("minimum", Math.min);
		if (low !== domain.minimum)
			tails.push({
				values: whole
					? `${low ?? "…"}–${domain.minimum - 1}`
					: `below ${domain.minimum}${low === undefined ? "" : ` down to ${low}`}`,
			});
	}
	if (domain.maximum !== undefined) {
		const high = wider("maximum", Math.max);
		if (high !== domain.maximum)
			tails.push({
				values: whole
					? `${domain.maximum + 1}–${high ?? "…"}`
					: `above ${domain.maximum}${high === undefined ? "" : ` up to ${high}`}`,
			});
	}
	if (domain.maxLength !== undefined) {
		const longest = wider("maxLength", Math.max);
		if (longest !== domain.maxLength)
			tails.push({ values: `${domain.maxLength + 1}–${longest ?? "…"} characters` });
	}
	return tails;
}

/** One creator option's obligations on one key; fixed values add none. */
export function optionObligations(
	key: Key & { verified: boolean },
	row: DerivedRow,
	option: DerivedOption,
	offered: Record<string, Offered> | undefined,
	slice: string,
): CoverageItem[] {
	const base = { ...key, slice, option: option.field };
	const domain = documented(row, option, key.operation);
	const disputed: CoverageItem[] = disputedTails(option).map(({ values }) => ({
		...base,
		values,
		state: "unknown",
		reason: "the catalog and the API schema disagree",
		question: 8,
	}));
	const blocked = (values: string): CoverageItem | null =>
		option.gap
			? { ...base, values, ...option.gap }
			: row.pending.length
				? { ...base, values, state: "pending", reason: row.pending.join("; ") }
				: null;
	if (option.kind === "count") {
		// `n: 1` is pinned. Shared counts above one are Phase 3 multi-output; a count with no
		// documented maximum is unknown, and values only one source documents are unknown. An
		// option's gap or its row's pending reasons come first.
		const numbers = domain.values?.filter((value): value is number => typeof value === "number");
		const max = numbers ? Math.max(1, ...numbers) : domain.maximum;
		if (max !== undefined && max <= 1) return disputed;
		const values = `2–${max ?? "…"}`;
		const first = blocked(values);
		if (first) return [first, ...disputed];
		return [
			max === undefined
				? {
						...base,
						values,
						state: "unknown",
						reason: `no documented maximum; counts above 1 are ${p3("multi-output and image sets")}`,
						question: 11,
					}
				: { ...base, values, state: "pending", reason: p3("multi-output and image sets") },
			...disputed,
		];
	}
	const items = disputed;
	const values = range(domain);
	const first = blocked(values);
	if (first) {
		items.push(first);
		return items;
	}
	if (key.verified) {
		const choice = offered?.[option.field];
		const gap = offerGap(domain, choice);
		items.push(
			gap
				? {
						...base,
						values,
						state: "pending",
						reason: gap,
						...(choice && "maxBytes" in choice && { envelope: true as const }),
					}
				: { ...base, values, state: "verified", reason: "offered in full" },
		);
		return items;
	}
	items.push({ ...base, values, state: "pending", reason: slice });
	return items;
}

export function coverage({
	rows = deriveRows(),
	offered = verifiedOptions(rows),
}: {
	rows?: DerivedRow[];
	offered?: readonly VerifiedOptions[];
} = {}) {
	const derived = new Map(rows.map((row) => [row.model, row]));
	const items: CoverageItem[] = [];
	for (const key of expandKeys()) {
		const row = key.provider === "poyo" ? derived.get(key.model) : undefined;
		const slice = assignment(key, row?.d4.d4);
		if (key.verified) items.push({ ...key, slice, state: "verified", reason: "shipped operation" });
		else if (slice.startsWith("Q ·"))
			items.push({ ...key, slice, state: "unknown", reason: slice, question: slice.slice(4) });
		else
			items.push({
				...key,
				slice,
				state: "pending",
				reason: row?.pending.length ? `${slice}; ${row.pending.join("; ")}` : slice,
			});
		if (row) {
			const choices = offered.find(
				(entry) =>
					entry.key.provider === key.provider &&
					entry.key.model === key.model &&
					entry.key.operation === key.operation,
			)?.offered;
			for (const option of row.options)
				items.push(...optionObligations(key, row, option, choices, slice));
		} else if (key.verified)
			items.push({
				...key,
				slice,
				option: "*",
				state: "pending",
				reason: "page options not yet typed in a descriptor (G10a, G11a)",
			});
	}
	return { items, ...tally(items) };
}

/** The five tag-blocking buckets. Each item counts once, in the first bucket it meets. */
export function tally(items: readonly CoverageItem[]) {
	const blocking = {
		envelope: 0,
		pending: 0,
		withoutPath: 0,
		unsupportedWithoutEvidence: 0,
		unknownWithoutQuestion: 0,
	};
	for (const item of items) {
		if (item.state === "verified" || item.state === "contract-covered") continue;
		if (item.state === "unsupported") {
			if (!item.evidence) blocking.unsupportedWithoutEvidence++;
		} else if (item.state === "unknown") {
			if (item.question === undefined) blocking.unknownWithoutQuestion++;
			else blocking.withoutPath++;
		} else if (item.envelope) blocking.envelope++;
		else blocking.pending++;
	}
	const total = Object.values(blocking).reduce((a, b) => a + b, 0);
	return { blocking, tagBlocking: total };
}

/** Order by UTF-16 code unit, independent of the host's locale. */
export const byCodeUnit = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);

const count = (items: readonly CoverageItem[], test: (item: CoverageItem) => boolean) =>
	items.filter(test).length;

export function summary(items: readonly CoverageItem[]) {
	const keys = items.filter((item) => item.option === undefined);
	const options = items.filter((item) => item.option !== undefined && item.option !== "*");
	const placeholders = items.filter((item) => item.option === "*");
	const byProvider = (provider: Provider) => keys.filter((key) => key.provider === provider);
	const verified = (list: CoverageItem[]) => count(list, ({ state }) => state === "verified");
	const engine = count(keys, (key) => /^G\d/.test(key.slice));
	const phase3 = count(keys, (key) => key.slice.startsWith("P3"));
	const questions = count(keys, (key) => key.slice.startsWith("Q"));
	const { blocking, tagBlocking } = tally(items);
	const states = (list: CoverageItem[]) =>
		coverageStates
			.map((state) => `${state} ${count(list, (item) => item.state === state)}`)
			.join(", ");
	return [
		`Expanded keys: ${keys.length}, of which Poyo.ai ${byProvider("poyo").length} (${verified(byProvider("poyo"))} verified) and ToAPIs ${byProvider("toapis").length} (${verified(byProvider("toapis"))} verified). Engine slices hold ${engine}, Phase 3 ${phase3} and evidence questions ${questions}. A route alias adds no key: Midjourney \`imagine\` counts once, on its primary route. \`catalog:coverage\` names each pending key's reason.`,
		"",
		`Keys: ${states(keys)}. Option obligations of the derived Poyo.ai rows: ${options.length}; ${states(options)}. Fixed values (the D4 \`false\`, a pinned \`n: 1\`, a fixed sentinel) add none.`,
		"",
		`The ${placeholders.length} verified ToAPIs operations each add one placeholder item until their page descriptors type their options (G10a, G11a). Each is pending and counts as tag-blocking.`,
		"",
		`**Tag-blocking count: ${tagBlocking}.** Pending pairs and options ${blocking.pending}; documented values a Siluet envelope excludes ${blocking.envelope}; options or pairs without a covered path, each with its question, ${blocking.withoutPath}; provider-unsupported pairs without evidence ${blocking.unsupportedWithoutEvidence}; unknown pairs or options without a question ${blocking.unknownWithoutQuestion}.`,
	].join("\n");
}

function operationsTable(items: readonly CoverageItem[]) {
	const groups = new Map<
		string,
		{ reason: string; provider: Provider; operation: string; keys: number; verified: number }
	>();
	for (const item of items) {
		if (item.option !== undefined) continue;
		const label = item.slice;
		const id = `${label}\n${item.provider}\n${item.operation}`;
		const group = groups.get(id) ?? {
			reason: label,
			provider: item.provider,
			operation: item.operation,
			keys: 0,
			verified: 0,
		};
		group.keys++;
		if (item.state === "verified") group.verified++;
		groups.set(id, group);
	}
	const names = { poyo: "Poyo.ai", toapis: "ToAPIs" };
	// Engine slices in slice order, then evidence questions, then Phase 3 by family.
	const rank = (label: string) => {
		const slice = /^G(\d+)([a-z]?)/.exec(label);
		if (slice) return Number(slice[1]) + (slice[2] ? (slice[2].charCodeAt(0) - 96) / 10 : 0);
		return label.startsWith("Q") ? 100 : 200;
	};
	const ordered = [...groups.values()].sort(
		(a, b) =>
			rank(a.reason) - rank(b.reason) ||
			(rank(a.reason) < 100 ? 0 : byCodeUnit(a.reason, b.reason)) ||
			(a.provider === b.provider ? 0 : a.provider === "poyo" ? -1 : 1) ||
			b.keys - a.keys ||
			byCodeUnit(a.operation, b.operation),
	);
	return [
		"| Assigned to | Provider | Operation | Keys | Verified |",
		"| --- | --- | --- | ---: | ---: |",
		...ordered.map(
			(row) =>
				`| ${row.reason} | ${names[row.provider]} | \`${row.operation}\` | ${row.keys} | ${row.verified || ""} |`,
		),
	].join("\n");
}

function optionGaps(items: readonly CoverageItem[]) {
	const byModel = new Map<string, Map<string, Set<string>>>();
	for (const item of items) {
		if (item.provider !== "poyo" || item.option === undefined || item.state === "verified")
			continue;
		if (item.state === "pending" && item.reason === item.slice) continue;
		const reasons = byModel.get(item.model) ?? new Map<string, Set<string>>();
		const reason =
			item.state === "unknown" ? `question ${item.question}: ${item.reason}` : item.reason;
		reasons.set(reason, (reasons.get(reason) ?? new Set()).add(`\`${item.option}\``));
		byModel.set(item.model, reasons);
	}
	return [
		"| ID | Options beyond the row's slice |",
		"| --- | --- |",
		...[...byModel.entries()]
			.sort(([a], [b]) => (a < b ? -1 : 1))
			.map(
				([model, reasons]) =>
					`| \`${model}\` | ${[...reasons.entries()]
						.map(
							([reason, fields]) => `${[...fields].join(", ")}: ${reason.replaceAll("|", "\\|")}`,
						)
						.join("; ")} |`,
			),
	].join("\n");
}

function promptLimits(items: readonly CoverageItem[]) {
	const silent = items.filter((item) => item.question === 10 && item.provider === "poyo");
	const rows = new Map<string, Set<string>>();
	for (const item of silent) {
		const media = ledger.providers.poyo.rows.find((row) => row.ids.includes(item.model))?.media;
		const envelope = media === "video" ? "4,000 UTF-8 bytes" : "5,000 code points";
		const id = `${envelope}\n${item.option}`;
		rows.set(id, (rows.get(id) ?? new Set()).add(`\`${item.model}\``));
	}
	for (const [id, models] of rows) {
		const sorted = [...models].sort((a, b) => (a.slice(1, -1) < b.slice(1, -1) ? -1 : 1));
		rows.set(id, new Set(sorted));
	}
	return [
		"| Envelope | IDs | Field |",
		"| --- | --- | --- |",
		...[...rows.entries()].map(([id, models]) => {
			const [envelope, field] = id.split("\n");
			return `| ${envelope} | ${[...models].join(", ")} | \`${field}\` |`;
		}),
	].join("\n");
}

export const inventoryPath = new URL("../../docs/catalog-engine-inventory.md", import.meta.url);

/** The inventory with each generated section replaced by its current output. */
export function renderInventory(current: string, items = coverage().items) {
	const sections: Record<string, string> = {
		summary: summary(items),
		operations: operationsTable(items),
		"option-gaps": optionGaps(items),
		"prompt-limits": promptLimits(items),
	};
	return current.replace(
		/(<!-- catalog:coverage (\S+) -->\n)[\s\S]*?(\n<!-- \/catalog:coverage -->)/g,
		(_match, open: string, name: string, close: string) => {
			const section = sections[name];
			if (section === undefined) throw new Error(`Unknown inventory section ${name}.`);
			return `${open}${section}${close}`;
		},
	);
}

if (import.meta.main) {
	const result = coverage();
	console.log(summary(result.items));
	console.table({ poyo: catalogCoverage("poyo"), toapis: catalogCoverage("toapis") });
	if (process.argv.includes("--write")) {
		const current = readFileSync(inventoryPath, "utf8");
		writeFileSync(inventoryPath, renderInventory(current, result.items));
	}
}
