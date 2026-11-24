import type { PageProps } from "./$types";

type Job = PageProps["data"]["jobs"][number];
export type FileSlot = NonNullable<Job["file"]>["slots"][number];

// A local-file edit's upload and edit boundary, when it says more than the job state.
const fileStates = {
	claimed: "Preparing upload",
	uploading: "Uploading file",
	uploaded: "File uploaded · preparing edit",
	editing: "Submitting edit",
	unsent: "No upload or edit sent",
	stored: "File uploaded · edit not sent",
	"upload-unknown": "Upload outcome unknown · edit not sent",
	"edit-unknown": "May have been submitted",
	"upload-rejected": "Upload rejected · edit not sent",
	"edit-recorded": null,
} as const;

/** The phase label, counted from the file slots when a job uploads more than one file. */
export function fileStateLabel(
	phase: NonNullable<Job["filePhase"]>,
	slots: readonly FileSlot[],
): string | null {
	const total = slots.length;
	if (total < 2) return fileStates[phase];
	// An unusable link was still uploaded.
	const uploaded = slots.filter(
		({ outcome }) => outcome === "stored" || outcome === "unusable",
	).length;
	const waiting = slots.some(({ outcome }) => outcome === "unsent");
	const current = slots.findIndex(({ outcome }) => outcome === "uploading");
	switch (phase) {
		case "uploading":
			return current < 0
				? fileStates.uploading
				: `Uploading reference ${slots[current].position} · file ${current + 1} of ${total}`;
		case "uploaded":
			return waiting
				? `${uploaded} of ${total} files uploaded`
				: `${total} files uploaded · preparing edit`;
		case "stored":
			return `${uploaded} of ${total} files uploaded · edit not sent`;
		default:
			return fileStates[phase];
	}
}
