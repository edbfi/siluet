import type { StageDescriptor } from "../../../shared/image-studio/file-edit";
import type { MediaDescriptor } from "../../../shared/media-staging/descriptor";
import { type FileRequest, parseFileRequest } from "./request";

/** A version 3 body: each reference a staged descriptor or a public URL, in order. */
export function orderedBody(
	draft: Record<string, unknown>,
	references: readonly (MediaDescriptor | string)[],
	extra: Record<string, unknown> = {},
) {
	return {
		draft: {
			...draft,
			references: references.map((reference) =>
				typeof reference === "string"
					? { kind: "url", url: reference }
					: { kind: "file", stage: reference },
			),
		},
		count: 1,
		retryLimit: 0,
		acceptUnknown: false,
		...extra,
	};
}

export function parsedRequest(value: unknown): FileRequest {
	const live = parseFileRequest(value);
	if (!live || "error" in live) throw new Error(`Invalid fixture: ${JSON.stringify(live)}`);
	return live;
}

type Reviewed = { files: { position: number; stage: StageDescriptor }[]; token: string };

/** The body of `live` again, with a Review's descriptors and token, as Queue sends it. */
export function bodyOf(
	live: FileRequest,
	{ files, token, acceptUnknown }: Partial<Reviewed> & { acceptUnknown?: boolean } = {},
) {
	const stages = new Map(files?.map(({ position, stage }) => [position, stage]));
	const sent = token ?? live.token;
	return {
		draft: {
			...live.draft,
			references: live.slots.map((slot, index) =>
				slot.kind === "url"
					? { kind: "url", url: slot.url }
					: { kind: "file", stage: stages.get(index + 1) ?? slot.stage },
			),
		},
		count: 1,
		retryLimit: 0,
		acceptUnknown: acceptUnknown ?? live.acceptUnknown,
		...(sent !== undefined && { token: sent }),
	};
}

/** The Queue click for a Review: its descriptors, its token and consent. */
export const clickFor = (live: FileRequest, review: Reviewed) =>
	parsedRequest(bodyOf(live, { ...review, acceptUnknown: true }));
