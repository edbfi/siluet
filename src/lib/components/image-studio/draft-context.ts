import { createContext } from "svelte";
import type { DerivedDraft } from "#lib/shared/image-studio/derived.ts";
import type { SeedreamDraft } from "#lib/shared/image-studio/seedream.ts";

import type { ZImageDraft } from "#lib/shared/image-studio/z-image.ts";

export type ReferenceSlotDraft = { key: number; identity: number; privateName: string };
export type ReferenceDraft = { slots: ReferenceSlotDraft[]; nextIdentity: number };

export type ComposerDraft =
	| { model: "seedream-5.5"; request: SeedreamDraft; references: ReferenceDraft }
	| { model: "z-image"; request: ZImageDraft; privateName: string }
	/** A Queue-eligible derived row; `request.model` names its exact ID. */
	| { model: "derived"; request: DerivedDraft };

export type ImageDraftMemory = {
	draft?: ComposerDraft;
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
