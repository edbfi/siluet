import { filePlaceholder, type StageDescriptor } from "../../../shared/image-studio/file-edit";
import { maxSeedreamReferences } from "../../../shared/image-studio/references";
import { parseStageDescriptor } from "../../../shared/media-staging/descriptor";
import { isRecord } from "../../providers/connection-check";
import { parseQueueRequest } from "../queue/request";

/** One ordered reference: a public URL as typed, or a staged local file. */
export type OrderedReference =
	| { kind: "url"; url: string }
	| { kind: "file"; stage: StageDescriptor };
const placeholderHost = new URL(filePlaceholder).hostname;

/** The placeholder a file slot's URL takes until its upload returns a hosted URL. */
export const slotPlaceholder = (position: number) => `${filePlaceholder}#${position}`;

const sortedOptions = (options: unknown) =>
	Object.fromEntries(
		Object.entries(isRecord(options) ? options : {}).sort(([a], [b]) => a.localeCompare(b)),
	);

/** Validate the exact edit options with `urls` as the references, as a URL edit would. */
function editRequest(
	request: Record<string, unknown>,
	draft: Record<string, unknown>,
	urls: string[],
) {
	const live = parseQueueRequest({
		...request,
		draft: { ...draft, references: urls.map((url) => ({ kind: "url", url })) },
	});
	if (live?.entry.mode !== "edit" || live.count !== 1 || live.retryLimit !== 0) return null;
	const { input } = live;
	if (input.model !== "seedream-5.5" && input.model !== "doubao-seedream-5-5") return null;
	return { ...live, input };
}

/** Positions sharing a trimmed URL, a stage handle or a verified digest. */
function duplicatePositions(slots: OrderedReference[]) {
	const seen = new Map<string, number>();
	const positions = new Set<number>();
	for (const [index, slot] of slots.entries()) {
		const keys =
			slot.kind === "url"
				? [`url ${slot.url}`]
				: [`handle ${slot.stage.handle}`, `digest ${slot.stage.digest}`];
		for (const key of keys) {
			const first = seen.get(key);
			if (first === undefined) seen.set(key, index + 1);
			else positions.add(first).add(index + 1);
		}
	}
	return [...positions].sort((a, b) => a - b);
}

/**
 * The single-file body R1b's Review issued (version 2): the flat URL-edit wire format with
 * the bare upload placeholder as its only reference and a top-level stage. Queue parses it
 * only to replay a claimed job or to answer an unused Review `stale`.
 */
function parseR1bBody(value: Record<string, unknown>) {
	const { stage, ...request } = value;
	const parsed = parseStageDescriptor(stage) as StageDescriptor | null;
	const draft = request.draft;
	if (!parsed || !isRecord(draft) || !Array.isArray(draft.references)) return null;
	const [ref] = draft.references;
	if (
		draft.references.length !== 1 ||
		!isRecord(ref) ||
		Object.keys(ref).length !== 2 ||
		ref.kind !== "upload" ||
		ref.url !== filePlaceholder
	)
		return null;
	const live = editRequest(request, draft, [filePlaceholder]);
	if (!live) return null;
	return {
		...live,
		version: 2 as const,
		draft: {
			operation: draft.operation,
			provider: draft.provider,
			prompt: draft.prompt,
			references: [{ kind: "upload", url: filePlaceholder }],
			options: sortedOptions(draft.options),
		},
		slots: [{ kind: "file", stage: parsed }] as OrderedReference[],
		files: [{ position: 1, stage: parsed }],
	};
}

/**
 * Parse a file Review or Queue body: one Seedream edit with 1–10 ordered references, each
 * a public URL or a staged file, at least one file, one request and zero retries. Each file
 * slot carries its own seven-key stage. Duplicates answer with their positions before any
 * URL is parsed.
 */
export function parseFileRequest(value: unknown): FileRequest | Duplicate | null {
	if (!isRecord(value)) return null;
	if ("stage" in value) return parseR1bBody(value);
	const draft = value.draft;
	if (!isRecord(draft) || !Array.isArray(draft.references)) return null;
	const references: unknown[] = draft.references;
	if (references.length < 1 || references.length > maxSeedreamReferences) return null;
	const slots: OrderedReference[] = [];
	for (const reference of references) {
		if (!isRecord(reference)) return null;
		const keys = Object.keys(reference).sort().join();
		if (reference.kind === "url" && typeof reference.url === "string") {
			if (keys !== "kind,url" && keys !== "hostname,kind,url") return null;
			if (reference.hostname !== undefined && typeof reference.hostname !== "string") return null;
			slots.push({ kind: "url", url: reference.url.trim() });
		} else if (reference.kind === "file" && keys === "kind,stage") {
			const stage = parseStageDescriptor(reference.stage) as StageDescriptor | null;
			if (!stage) return null;
			slots.push({ kind: "file", stage });
		} else return null;
	}
	const files = slots.flatMap((slot, index) =>
		slot.kind === "file" ? [{ position: index + 1, stage: slot.stage }] : [],
	);
	if (!files.length) return null;
	const duplicates = duplicatePositions(slots);
	if (duplicates.length) return { error: "duplicate", positions: duplicates };
	// A URL slot may never stand in for a file's upload.
	for (const slot of slots)
		if (slot.kind === "url" && URL.parse(slot.url)?.hostname.replace(/\.$/, "") === placeholderHost)
			return null;
	return orderedRequest(value, draft, slots, files);
}

function orderedRequest(
	value: Record<string, unknown>,
	draft: Record<string, unknown>,
	slots: OrderedReference[],
	files: { position: number; stage: StageDescriptor }[],
) {
	const live = editRequest(
		value,
		draft,
		slots.map((slot, index) => (slot.kind === "url" ? slot.url : slotPlaceholder(index + 1))),
	);
	if (!live) return null;
	return {
		...live,
		version: 3 as const,
		draft: {
			operation: draft.operation,
			provider: draft.provider,
			prompt: draft.prompt,
			references: slots.map((slot) =>
				slot.kind === "url" ? { kind: "url", url: slot.url } : { kind: "file" },
			),
			options: sortedOptions(draft.options),
		},
		slots,
		files,
	};
}
type Duplicate = { error: "duplicate"; positions: number[] };
export type FileRequest = NonNullable<
	ReturnType<typeof parseR1bBody> | ReturnType<typeof orderedRequest>
>;
