// What each verified operation's composer offers today, read from the shipped constants and the
// derived rows, so coverage notices when a creator option leaves the composer. Fixed values (the
// D4 `false`, a pinned `n: 1`, a fixed sentinel such as Seedance edit's `-1`) are not choices and
// are not listed. Nothing here reads a generated projection: the deriver and coverage pass the
// rows in.
import {
	poyoAspectRatios,
	poyoPromptLimits,
	seedreamBackgrounds,
	seedreamResolutions,
} from "../../src/lib/shared/image-studio/seedream-options";
import { zImagePromptCharacters, zImageSizes } from "../../src/lib/shared/image-studio/z-image";
import { offeredFormats } from "../../src/lib/shared/media-catalog/formats";
import { h3MaxOperation, releasedOperations } from "../../src/lib/shared/media-catalog/registry";
import { videoPromptBytes } from "../../src/lib/shared/video-studio/prompt-limit";
import type { DerivedRow } from "./derive";
import { formatEvidence } from "./format-evidence";

export type Offered =
	| { readonly values: readonly unknown[] }
	| { readonly minimum: number; readonly maximum: number }
	| { readonly maxCodePoints: number }
	| { readonly maxBytes: number };

type Key = (typeof releasedOperations)[number]["key"];
export type VerifiedOptions = { readonly key: Key; readonly offered: Record<string, Offered> };

/** The formats a row's own `output_format` offers, as the composer reads them. */
function rowFormats(rows: readonly DerivedRow[], model: string): Offered {
	const row = rows.find((candidate) => candidate.model === model);
	const option = row?.options.find(({ field }) => field === "output_format");
	const formats = offeredFormats(formatEvidence(option));
	return { values: formats.state === "offered" ? formats.values : [] };
}

const seedream = (edit: boolean, formats: Offered): Record<string, Offered> => ({
	prompt: { maxCodePoints: poyoPromptLimits.max },
	size: { values: edit ? [...poyoAspectRatios, "auto"] : poyoAspectRatios },
	resolution: { values: seedreamResolutions },
	background: { values: seedreamBackgrounds },
	output_format: formats,
});
const { fields } = h3MaxOperation.descriptor;

/** Poyo.ai choices per verified key. ToAPIs options wait for their page descriptors (G10a, G11a). */
function poyoOffered(rows: readonly DerivedRow[]): Record<string, Record<string, Offered>> {
	const formats = rowFormats(rows, "seedream-5.5");
	return {
		"seedream-5.5 text-to-image": seedream(false, formats),
		"seedream-5.5 reference-image-edit": seedream(true, formats),
		"z-image text-to-image": {
			prompt: { maxCodePoints: zImagePromptCharacters },
			size: { values: zImageSizes },
		},
		// The edit composer offers every size as an optional choice.
		"z-image reference-image-edit": {
			prompt: { maxCodePoints: zImagePromptCharacters },
			size: { values: zImageSizes },
		},
		"h3-max text-to-video": {
			prompt: { maxBytes: videoPromptBytes },
			duration: { minimum: fields.duration.min, maximum: fields.duration.max },
			resolution: { values: fields.resolution.values },
			aspect_ratio: { values: fields.aspect_ratio.values },
		},
	};
}

/** Each released operation's composer choices, given the derived rows they are checked against. */
export function verifiedOptions(rows: readonly DerivedRow[]): readonly VerifiedOptions[] {
	const offered = poyoOffered(rows);
	return releasedOperations.map(({ key }) => ({
		key,
		offered: key.provider === "poyo" ? (offered[`${key.model} ${key.operation}`] ?? {}) : {},
	}));
}
