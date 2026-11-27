// Family representatives verified on the derived path (catalog engine spec, "Families and
// admission"): each passed the seven D2 fixtures and a built-app journey for the classes it
// qualifies. Unlike released operations, they keep no hand-written descriptor; their composer
// and request come from their queue row.
import type { FilteringEvidence } from "./filtering";
import type { QueueKey } from "./queue-row";

export const derivedVerifiedOperations: readonly {
	readonly key: QueueKey;
	readonly profile: string;
	readonly evidence: FilteringEvidence;
}[] = [
	{
		// Booleans (`prompt_extend`) and integers (`seed`) on Poyo.ai images (G4).
		key: {
			provider: "poyo",
			model: "qwen-image-2.1",
			route: "POST /api/generate/submit",
			operation: "text-to-image",
		},
		profile: "qwen-image-2.1-generate",
		evidence: { d4: "declared" },
	},
];
