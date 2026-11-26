// bun run catalog:coverage: expands every documented ledger key and every creator option of
// the derived Poyo.ai rows, gives each exactly one state and prints the tag-blocking count.
// `--write` regenerates the generated sections of docs/catalog-engine-inventory.md.
import { readFileSync, writeFileSync } from "node:fs";
import ledger from "../../docs/media-catalog.v1.json";
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

/** The slice, Phase 3 family or evidence question that holds one key. */
export function assignment({ provider, route, operation }: Key) {
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
	return label;
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

/** One creator option's obligations on one key; fixed values add none. */
function optionItems(
	key: Key & { verified: boolean },
	row: DerivedRow,
	option: DerivedOption,
	offered: Record<string, Offered> | undefined,
	slice: string,
): CoverageItem[] {
	const base = { ...key, option: option.field };
	const domain = documented(row, option, key.operation);
	const items: CoverageItem[] = [];
	if (option.disputed && option.domain.values) {
		const disputed = [
			...new Set([
				...(option.disputed.catalog.values ?? []),
				...(option.disputed.api.values ?? []),
			]),
		].filter((value) => !option.domain.values?.includes(value));
		if (disputed.length)
			items.push({
				...base,
				values: range({ values: disputed }),
				state: "unknown",
				reason: "the catalog and the API schema disagree",
				question: 8,
			});
	}
	if (option.kind === "count") {
		// `n: 1` is pinned. Shared counts above one are Phase 3 multi-output, and values only
		// one source documents are unknown.
		const max = domain.maximum ?? 1;
		const other = Math.max(
			option.disputed?.catalog.maximum ?? max,
			option.disputed?.api.maximum ?? max,
		);
		if (max > 1)
			items.push({
				...base,
				values: `2–${max}`,
				state: "pending",
				reason: p3("multi-output and image sets"),
			});
		if (other > max)
			items.push({
				...base,
				values: `${max + 1}–${other}`,
				state: "unknown",
				reason: "the catalog and the API schema disagree",
				question: 8,
			});
		return items;
	}
	const values = range(domain);
	if (option.gap) {
		items.push({ ...base, values, ...option.gap });
		return items;
	}
	if (row.pending.length) {
		items.push({ ...base, values, state: "pending", reason: row.pending.join("; ") });
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
	offered = verifiedOptions,
}: {
	rows?: DerivedRow[];
	offered?: readonly VerifiedOptions[];
} = {}) {
	const derived = new Map(rows.map((row) => [row.model, row]));
	const items: CoverageItem[] = [];
	for (const key of expandKeys()) {
		const slice = assignment(key);
		const row = key.provider === "poyo" ? derived.get(key.model) : undefined;
		if (key.verified) items.push({ ...key, state: "verified", reason: "shipped operation" });
		else if (slice.startsWith("Q ·"))
			items.push({ ...key, state: "unknown", reason: slice, question: slice.slice(4) });
		else
			items.push({
				...key,
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
				items.push(...optionItems(key, row, option, choices, slice));
		} else if (key.verified)
			items.push({
				...key,
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

const count = (items: readonly CoverageItem[], test: (item: CoverageItem) => boolean) =>
	items.filter(test).length;

function summary(items: readonly CoverageItem[]) {
	const keys = items.filter((item) => item.option === undefined);
	const options = items.filter((item) => item.option !== undefined);
	const byProvider = (provider: Provider) => keys.filter((key) => key.provider === provider);
	const verified = (list: CoverageItem[]) => count(list, ({ state }) => state === "verified");
	const engine = count(keys, (key) => /^G\d/.test(assignment(key)));
	const phase3 = count(keys, (key) => assignment(key).startsWith("P3"));
	const questions = count(keys, (key) => assignment(key).startsWith("Q"));
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
		const label = assignment(item);
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
			(rank(a.reason) < 100 ? 0 : a.reason.localeCompare(b.reason)) ||
			(a.provider === b.provider ? 0 : a.provider === "poyo" ? -1 : 1) ||
			b.keys - a.keys ||
			a.operation.localeCompare(b.operation),
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
		if (item.state === "pending" && item.reason === assignment(item)) continue;
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
