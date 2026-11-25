// Gallery's per-mode video Save limit (D6, docs/SPEC-video-save-limits.md).

/**
 * The longest output documented for one exact operation, in whole seconds. `provider` quotes
 * the provider's own maximum; `upstream` an uncontradicted upstream cap for a source-following
 * operation, unverified on the provider's route.
 */
export type SaveLimit = Readonly<{ seconds: number; basis: "provider" | "upstream" }>;

/** The largest limit Gallery accepts; its storage ceiling adds the allowance. */
export const maxSaveSeconds = 60;
/** Gallery's local allowance for container rounding, not a provider guarantee. */
export const saveAllowanceSeconds = 1;

export const saveLimitBlocker =
	"Queue is unavailable because Gallery cannot bound this mode's output length.";

/** Why a value is not a Save limit in whole seconds from 1 to 60, or null. */
export function saveSecondsProblem(value: unknown) {
	return typeof value === "number" &&
		Number.isInteger(value) &&
		value >= 1 &&
		value <= maxSaveSeconds
		? null
		: `A Save limit is a whole number of seconds from 1 to ${maxSaveSeconds}.`;
}

function bounded(save: SaveLimit | null) {
	return save &&
		saveSecondsProblem(save.seconds) === null &&
		(save.basis === "provider" || save.basis === "upstream")
		? save
		: null;
}

/** The Review blocker of an operation Gallery cannot bound, or null. */
export function saveLimitProblem(operation: { save: SaveLimit | null }) {
	return bounded(operation.save) ? null : saveLimitBlocker;
}

/** The Review disclosure of an operation's Save limit; none when it has no valid limit. */
export function saveDisclosure(operation: { save: SaveLimit | null }) {
	const save = bounded(operation.save);
	if (!save) return null;
	const source =
		save.basis === "provider"
			? "the provider's documented maximum for this mode"
			: "the upstream model's documented maximum for this mode, unverified on this route";
	return `Gallery saves complete H.264/AAC MP4 files up to ${save.seconds} seconds, ${source}, plus ${saveAllowanceSeconds} second for container rounding, within its size and dimension limits. A completed billable clip outside them stays with the provider.`;
}
