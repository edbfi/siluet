import { filePlaceholder, type StageDescriptor } from "../../../shared/image-studio/file-edit";
import { parseStageDescriptor } from "../../../shared/media-staging/descriptor";
import { isRecord } from "../../providers/connection-check";
import { parseQueueRequest } from "../queue/request";

/**
 * Parse a file Review or Queue body: the flat URL-edit wire format with the upload
 * placeholder as its only reference, one request, zero retries and the seven-key stage.
 */
export function parseFileRequest(value: unknown) {
	if (!isRecord(value)) return null;
	const { stage, ...request } = value;
	const parsed: StageDescriptor | null = parseStageDescriptor(stage);
	const draft = request.draft;
	if (
		!parsed ||
		request.count !== 1 ||
		request.retryLimit !== 0 ||
		!isRecord(draft) ||
		draft.operation !== "edit" ||
		!Array.isArray(draft.references) ||
		draft.references.length !== 1
	)
		return null;
	const [ref] = draft.references;
	if (
		!isRecord(ref) ||
		Object.keys(ref).length !== 2 ||
		ref.kind !== "upload" ||
		ref.url !== filePlaceholder
	)
		return null;
	// Validate the exact edit options with the reviewed placeholder as the sole URL.
	const live = parseQueueRequest({
		...request,
		draft: { ...draft, references: [{ kind: "url", url: filePlaceholder }] },
	});
	if (!live || live.entry.mode !== "edit") return null;
	const { input } = live;
	if (input.model !== "seedream-5.5" && input.model !== "doubao-seedream-5-5") return null;
	return {
		...live,
		input,
		draft: {
			operation: draft.operation,
			provider: draft.provider,
			prompt: draft.prompt,
			references: [{ kind: "upload", url: filePlaceholder }],
			options: Object.fromEntries(
				Object.entries(isRecord(draft.options) ? draft.options : {}).sort(([a], [b]) =>
					a.localeCompare(b),
				),
			),
		},
		stage: parsed,
	};
}
export type FileRequest = NonNullable<ReturnType<typeof parseFileRequest>>;
