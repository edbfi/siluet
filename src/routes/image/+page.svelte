<script lang="ts">
import { untrack } from "svelte";
import {
	type ComposerDraft,
	createReferenceDraft,
	getImageDraftContext,
	referenceLabel,
} from "#lib/components/image-studio/draft-context.ts";
import ImageComposer from "#lib/components/image-studio/ImageComposer.svelte";
import ImageReview from "#lib/components/image-studio/ImageReview.svelte";
import SeedreamFields from "#lib/components/image-studio/SeedreamFields.svelte";
import ZImageFields from "#lib/components/image-studio/ZImageFields.svelte";
import { duplicateReferenceSlots } from "#lib/shared/image-studio/references.ts";
import { createImageReview } from "#lib/shared/image-studio/review.ts";
import {
	buildSeedreamRequest,
	createSeedreamDraft,
	validateSeedreamDraft,
} from "#lib/shared/image-studio/seedream.ts";
import {
	buildZImageRequest,
	createZImageDraft,
	validateZImageDraft,
} from "#lib/shared/image-studio/z-image.ts";
import {
	releasedImageOperations,
	seedreamModel,
	zImageModel,
} from "#lib/shared/media-catalog/registry.ts";
import type { PageProps } from "./$types";

let { data }: PageProps = $props();
const memory = getImageDraftContext();
const headingId = "studio-review-title";
let composer = $state<ComposerDraft>(
	untrack(
		() =>
			memory.draft ?? {
				model: "seedream-5.5",
				request: createSeedreamDraft(data.eligibleProviders[0] ?? null),
				references: createReferenceDraft(),
			},
	),
);
let shell: ReturnType<typeof ImageComposer>;
let previewIndex = $state(0);
function switchModel(id: string) {
	const { prompt, operation } = composer.request;
	if (id === composer.model) return;
	composer =
		id === zImageModel.id
			? { model: id, request: createZImageDraft(operation, prompt), privateName: "" }
			: {
					model: seedreamModel.id,
					request: { ...createSeedreamDraft(data.eligibleProviders[0] ?? null, operation), prompt },
					references: createReferenceDraft(),
				};
	previewIndex = 0;
}
const duplicateWarning = $derived.by(() => {
	if (composer.model !== "seedream-5.5") return null;
	const positions = duplicateReferenceSlots(composer.request.references);
	return positions
		? `Reference images ${positions[0]} and ${positions[1]} use the same URL.`
		: null;
});
const seedream = $derived(
	composer.model === "seedream-5.5"
		? validateSeedreamDraft(composer.request, data.eligibleProviders)
		: null,
);
const zImage = $derived(
	composer.model === "z-image" ? validateZImageDraft(composer.request) : null,
);
const active = $derived.by(() => {
	if (zImage?.ok) {
		const { input } = zImage;
		return {
			entry:
				releasedImageOperations.find(
					(entry) => entry.modelId === input.model && entry.mode === input.operation,
				) ?? null,
			review: createImageReview(input, buildZImageRequest(input)),
		};
	}
	if (seedream?.ok) {
		const { input, entry } = seedream;
		return {
			entry,
			review: createImageReview(
				input,
				buildSeedreamRequest(input, (source) =>
					source.kind === "url" ? source.url : "[local image]",
				),
			),
		};
	}
	return null;
});
$effect(() => {
	memory.draft = composer;
});
</script>
<svelte:head><title>Image Studio · Siluet</title></svelte:head>
<ImageComposer
	bind:this={shell}
	model={composer.model === "z-image" ? zImageModel : seedreamModel}
	onModel={switchModel}
	reviewHref={`#${headingId}`}
	operation={composer.request.operation}
	{previewIndex}
	reference={composer.request.references[previewIndex]}
>
	{#snippet fields()}
		{#if composer.model === "seedream-5.5" && seedream}
			<SeedreamFields
				eligibleProviders={data.eligibleProviders}
				unavailableProviders={data.unavailableProviders}
				bind:draft={composer.request}
				bind:referenceDraft={composer.references}
				validation={seedream}
				{duplicateWarning}
				bind:previewIndex
				focusPreview={() => shell.focusPreview()}
			/>
		{:else if composer.model === "z-image"}
			<ZImageFields
				bind:draft={composer.request}
				bind:privateName={composer.privateName}
				connected={data.zImageConnected}
				promptError={zImage && !zImage.ok ? zImage.errors.prompt : undefined}
			/>
		{/if}
	{/snippet}
	{#snippet reviewPanel()}
		<ImageReview
			modelId={composer.model}
			connected={composer.model === "z-image" ? data.zImageConnected : !!composer.request.provider}
			entry={active?.entry ?? null}
			review={active?.review ?? null}
			draft={composer.request}
			referenceLabels={composer.model === "seedream-5.5"
				? composer.references.slots.map((slot) => referenceLabel(slot.identity))
				: []}
			{duplicateWarning}
			{headingId}
			feeds={data.pricingFeeds}
			nowMs={data.pricingNowMs}
			provider={composer.request.provider ?? undefined}
			operation={composer.request.operation}
		/>
	{/snippet}
</ImageComposer>
