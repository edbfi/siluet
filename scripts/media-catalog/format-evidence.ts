// A derived row's output-format option as the evidence the pure formats module reads. The
// formats projection and the verified options share it, so the composer and coverage offer
// exactly what the row's own data documents.
import type { FormatEvidence, PendingFormat } from "../../src/lib/shared/media-catalog/formats";
import type { DerivedOption } from "./derive";

/** The option's values and resolved default, its gap's reason when it has one, or nothing. */
export function formatEvidence(
	option: DerivedOption | undefined,
): FormatEvidence | PendingFormat | undefined {
	if (!option) return undefined;
	if (option.gap) return { pending: option.gap.reason };
	const resolved = option.default.state === "resolved" ? option.default.value : undefined;
	return {
		values: option.domain.values as string[],
		...(typeof resolved === "string" && { default: resolved }),
	};
}
