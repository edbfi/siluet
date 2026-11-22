import { createContext } from "svelte";
import type { SeedreamDraft } from "#lib/shared/image-studio/seedream.ts";

export type ReferenceSlotDraft = { key: number; identity: number; privateName: string };
export type ReferenceDraft = { slots: ReferenceSlotDraft[]; nextIdentity: number };

export type ImageDraftMemory = {
	draft?: { request: SeedreamDraft; references: ReferenceDraft };
};

export function createReferenceDraft(): ReferenceDraft {
	return { slots: [{ key: 0, identity: 0, privateName: "" }], nextIdentity: 1 };
}

export function referenceLabel(identity: number): string {
	const letter = String.fromCharCode(65 + (identity % 26));
	const group = Math.floor(identity / 26);
	return `${letter}${group ? group + 1 : ""}`;
}

export const [getImageDraftContext, setImageDraftContext] = createContext<ImageDraftMemory>();
