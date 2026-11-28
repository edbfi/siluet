// Seedream's static choices and provider names. Nothing here reads a catalog projection, so the
// deriver's verified options and every module that only names a provider import it freely.
import type { ProviderId } from "../providers/connections";

export type SeedreamProvider = ProviderId;

export const seedreamProviderNames = { poyo: "Poyo.ai", toapis: "ToAPIs" } as const;

export const poyoAspectRatios = [
	"1:1",
	"4:3",
	"3:4",
	"16:9",
	"9:16",
	"3:2",
	"2:3",
	"21:9",
] as const;
export const seedreamResolutions = ["1K", "1.5K", "2K"] as const;
export const seedreamBackgrounds = ["auto", "opaque", "transparent"] as const;
export const toapisPixelLimits = { minArea: 921_600, maxArea: 4_624_220, maxRatio: 16 } as const;
export const poyoPromptLimits = { min: 5, max: 5000 } as const;
