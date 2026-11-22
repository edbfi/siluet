<script lang="ts">
import { untrack } from "svelte";
import {
	createReferenceDraft,
	getImageDraftContext,
	referenceLabel,
} from "#lib/components/image-studio/draft-context.ts";
import ImageComposer from "#lib/components/image-studio/ImageComposer.svelte";
import ImageReview from "#lib/components/image-studio/ImageReview.svelte";
import { duplicateReferenceSlots } from "#lib/shared/image-studio/references.ts";
import { createImageReview } from "#lib/shared/image-studio/review.ts";
import {
	buildSeedreamRequest,
	createSeedreamDraft,
	validateSeedreamDraft,
} from "#lib/shared/image-studio/seedream.ts";
import type { PageProps } from "./$types";

let { data }: PageProps = $props();
const memory = getImageDraftContext();
const headingId = "studio-review-title";
const composer = $state(
	untrack(
		() =>
			memory.draft ?? {
				request: createSeedreamDraft(data.eligibleProviders[0] ?? null),
				references: createReferenceDraft(),
			},
	),
);

const duplicateWarning = $derived.by(() => {
	const positions = duplicateReferenceSlots(composer.request.references);
	return positions
		? `Reference images ${positions[0]} and ${positions[1]} use the same URL.`
		: null;
});
const validation = $derived(validateSeedreamDraft(composer.request, data.eligibleProviders));
const referenceLabels = $derived(
	composer.references.slots.map((slot) => referenceLabel(slot.identity)),
);

const review = $derived(
	validation.ok
		? createImageReview(
				validation.input,
				buildSeedreamRequest(validation.input, (reference) =>
					reference.kind === "url" ? reference.url : "[local image]",
				),
			)
		: null,
);

$effect(() => {
	memory.draft = composer;
});
</script>

<svelte:head><title>Image Studio · Siluet</title></svelte:head>
<ImageComposer
	eligibleProviders={data.eligibleProviders}
	unavailableProviders={data.unavailableProviders}
	bind:draft={composer.request}
	bind:referenceDraft={composer.references}
	{validation}
	{duplicateWarning}
	reviewHref={`#${headingId}`}
>
	{#snippet reviewPanel()}
		<ImageReview
			entry={validation.ok ? validation.entry : null}
			{review}
			draft={composer.request}
			{referenceLabels}
			{duplicateWarning}
			{headingId}
			feeds={data.pricingFeeds}
			nowMs={data.pricingNowMs}
			provider={composer.request.provider ?? undefined}
			operation={composer.request.operation}
		/>
	{/snippet}
</ImageComposer>
