import { createContext } from "svelte";
import type { SeedreamDraft } from "#lib/shared/image-studio/seedream.ts";

export type ImageDraftMemory = { draft?: SeedreamDraft };

export const [getImageDraftContext, setImageDraftContext] = createContext<ImageDraftMemory>();
