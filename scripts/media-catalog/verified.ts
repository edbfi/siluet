// What each verified operation's composer offers today, read from the shipped constants, so
// coverage notices when a creator option leaves the composer. Fixed values (the D4 `false`,
// a pinned `n: 1`, a fixed sentinel such as Seedance edit's `-1`) are not choices and are not
// listed.
import {
	poyoAspectRatios,
	poyoPromptLimits,
	seedreamBackgrounds,
	seedreamOutputFormats,
	seedreamResolutions,
} from "../../src/lib/shared/image-studio/seedream";
import { zImagePromptCharacters, zImageSizes } from "../../src/lib/shared/image-studio/z-image";
import { h3MaxOperation, releasedOperations } from "../../src/lib/shared/media-catalog/registry";
import { videoPromptBytes } from "../../src/lib/shared/video-studio/request";

export type Offered =
	| { readonly values: readonly unknown[] }
	| { readonly minimum: number; readonly maximum: number }
	| { readonly maxCodePoints: number }
	| { readonly maxBytes: number };

type Key = (typeof releasedOperations)[number]["key"];
export type VerifiedOptions = { readonly key: Key; readonly offered: Record<string, Offered> };

const seedream = (edit: boolean): Record<string, Offered> => ({
	prompt: { maxCodePoints: poyoPromptLimits.max },
	size: { values: edit ? [...poyoAspectRatios, "auto"] : poyoAspectRatios },
	resolution: { values: seedreamResolutions },
	background: { values: seedreamBackgrounds },
	output_format: { values: seedreamOutputFormats },
});
const { fields } = h3MaxOperation.descriptor;

/** Poyo.ai choices per verified key. ToAPIs options wait for their page descriptors (G10a, G11a). */
const poyoOffered: Record<string, Record<string, Offered>> = {
	"seedream-5.5 text-to-image": seedream(false),
	"seedream-5.5 reference-image-edit": seedream(true),
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

export const verifiedOptions: readonly VerifiedOptions[] = releasedOperations.map(({ key }) => ({
	key,
	offered: key.provider === "poyo" ? (poyoOffered[`${key.model} ${key.operation}`] ?? {}) : {},
}));
