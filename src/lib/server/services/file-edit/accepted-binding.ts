import type { StageDescriptor } from "../../../shared/image-studio/file-edit";
import type { FileRequest, FileSlot } from "./request";

type Mac = (...parts: unknown[]) => string;
const stageFields = ({
	draft,
	handle,
	digest,
	mime,
	transform,
	size,
	deadline,
}: StageDescriptor) => ({
	draft,
	handle,
	digest,
	mime,
	transform,
	size,
	deadline,
});
/** Each ordered slot as signed: its exact trimmed URL, or its stage with its own draft. */
export const signedSlots = (slots: readonly FileSlot[]) =>
	slots.map((slot) => (slot.kind === "url" ? slot.url : stageFields(slot.stage)));

/**
 * The durable binding of an accepted file Review, matched by an identical replay. The
 * token's prefix picks it: `file3.` signs every ordered slot; `file2.` is R1b's single-file
 * binding over its exact inputs, used only to replay a job R1b claimed.
 */
export function acceptedFileBinding(mac: Mac, owner: string, token: string, live: FileRequest) {
	if (token.startsWith("file2.")) {
		const [file] = live.files;
		return mac(
			"file-accepted-owner-v2",
			owner,
			token,
			stageFields(file.stage),
			live.draft,
			live.request,
			1,
			0,
			live.acceptUnknown,
		);
	}
	return mac(
		"file-accepted-owner-v3",
		owner,
		token,
		signedSlots(live.slots),
		live.draft,
		live.request,
		1,
		0,
		live.acceptUnknown,
	);
}

/**
 * R1b's first-use signature of a single-file Review. An unused R1b Review that still
 * verifies is `stale` after the upgrade, never a new claim.
 */
export function r1bReviewSignature(
	mac: Mac,
	id: string,
	terms: string,
	owner: string,
	session: string,
	live: FileRequest,
) {
	const [file] = live.files;
	return mac(
		"file-review-v2",
		id,
		terms,
		owner,
		session,
		file.stage.draft,
		stageFields(file.stage),
		live.draft,
		live.request,
		1,
		0,
	);
}
