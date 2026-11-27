<script lang="ts">
import { untrack } from "svelte";
import DerivedImageFields from "#lib/components/image-studio/DerivedImageFields.svelte";
import {
	type ComposerDraft,
	createReferenceDraft,
	getImageDraftContext,
	referenceLabel,
} from "#lib/components/image-studio/draft-context.ts";
import ImageComposer from "#lib/components/image-studio/ImageComposer.svelte";
import ImageReview from "#lib/components/image-studio/ImageReview.svelte";
import { LocalCopies } from "#lib/components/image-studio/local-copy.svelte.ts";
import { setAside } from "#lib/components/image-studio/request-styles.ts";
import SeedreamFields from "#lib/components/image-studio/SeedreamFields.svelte";
import ZImageFields from "#lib/components/image-studio/ZImageFields.svelte";
import ReviewOnlyPanel from "#lib/components/media-catalog/ReviewOnlyPanel.svelte";
import {
	buildDerivedRequest,
	createDerivedDraft,
	validateDerivedDraft,
} from "#lib/shared/image-studio/derived.ts";
import {
	duplicateReferenceSlots,
	stageableReferences,
} from "#lib/shared/image-studio/references.ts";
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
import { queueRowFor } from "#lib/shared/media-catalog/image-queue.ts";
import { reviewOnlyFamily, reviewOnlyImageRows } from "#lib/shared/media-catalog/picker.ts";
import {
	releasedImageOperations,
	seedreamModel,
	zImageModel,
} from "#lib/shared/media-catalog/registry.ts";
import type { PageProps } from "./$types";

let { data }: PageProps = $props();
const memory = getImageDraftContext();
const headingId = "studio-review-title";
const reviewOnlyHeadingId = "studio-review-only-title";
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
// Siluet cleans each attached local file as soon as it is attached, in its own draft.
const localCopies = new LocalCopies(
	() => {
		if (composer.model !== "seedream-5.5" || composer.request.operation !== "edit") return null;
		const files = stageableReferences(composer.request.references);
		if (!files) return null;
		const { slots } = composer.references;
		return composer.request.references.map((reference, index) =>
			reference.kind === "file" ? { key: slots[index].key, file: reference.file } : null,
		);
	},
	() => data.cleaning,
);
let shell: ReturnType<typeof ImageComposer>;
let previewIndex = $state(0);
// A derived row is Review-only. Choosing it sets the shipped draft aside, so nothing can queue.
// Its fields and Review stay mounted, hidden, so a lost Queue's Retry and any file check survive.
let reviewOnly = $state.raw<(typeof reviewOnlyImageRows)[number] | null>(null);
let pending = $state<"review" | "queue" | null>(null);
// A Queue-eligible derived row's text-to-image operation, by its exact model ID.
const queueRow = (model: string) =>
	queueRowFor({
		provider: "poyo",
		model,
		route: "POST /api/generate/submit",
		operation: "text-to-image",
	});
const composerModel = $derived(
	composer.model === "derived" ? composer.request.model : composer.model,
);
function switchModel(id: string) {
	reviewOnly = reviewOnlyImageRows.find((row) => row.model === id) ?? null;
	if (reviewOnly) return;
	const { prompt } = composer.request;
	const operation = composer.request.operation === "edit" ? "edit" : "generate";
	if (id === composerModel) return;
	const eligible = queueRow(id);
	composer = eligible
		? { model: "derived", request: createDerivedDraft(eligible, prompt) }
		: id === zImageModel.id
			? { model: id, request: createZImageDraft(operation, prompt), privateName: "" }
			: {
					model: seedreamModel.id,
					request: { ...createSeedreamDraft(data.eligibleProviders[0] ?? null, operation), prompt },
					references: createReferenceDraft(),
				};
	previewIndex = 0;
}
const derivedRow = $derived(composer.model === "derived" ? queueRow(composer.request.model) : null);
const derivedCheck = $derived(
	composer.model === "derived" && derivedRow
		? validateDerivedDraft(derivedRow, composer.request)
		: null,
);
const refusedAt = $derived(
	data.refusals.find((refusal) => refusal.model === derivedRow?.key.model)?.refusedAt ?? null,
);
const duplicateWarning = $derived.by(() => {
	if (composer.model !== "seedream-5.5") return null;
	const positions = duplicateReferenceSlots(composer.request.references);
	if (positions) {
		const kind = composer.request.references[positions[0] - 1]?.kind === "file" ? "file" : "URL";
		return `Reference images ${positions[0]} and ${positions[1]} use the same ${kind}.`;
	}
	const same = localCopies.duplicates();
	return same.length
		? `Reference images ${same.slice(0, -1).join(", ")} and ${same.at(-1)} are the same file.`
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
	if (derivedCheck?.ok && derivedRow) {
		const request = buildDerivedRequest(derivedRow, derivedCheck.draft);
		const format = derivedCheck.draft.options.output_format;
		return {
			entry: { key: derivedRow.key, evidence: derivedRow.d4 },
			review: createImageReview(
				{
					provider: "poyo",
					operation: "generate",
					references: [],
					...(typeof format === "string" && { outputFormat: format }),
				},
				request,
			),
		};
	}
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
	modelId={reviewOnly?.model ?? composerModel}
	family={reviewOnly || composer.model === "derived"
		? reviewOnlyFamily("image")
		: (composer.model === "z-image" ? zImageModel : seedreamModel).family}
	reviewOnly={!!reviewOnly}
	locked={!!pending}
	onModel={switchModel}
	reviewHref={`#${reviewOnly ? reviewOnlyHeadingId : headingId}`}
	operation={composer.request.operation === "edit" ? "edit" : "generate"}
	{previewIndex}
	reference={composer.model === "derived" ? undefined : composer.request.references[previewIndex]}
>
	{#snippet fields()}
		<div class={setAside} hidden={!!reviewOnly}>
			{#if composer.model === "seedream-5.5" && seedream}
				<SeedreamFields
					eligibleProviders={data.eligibleProviders}
					unavailableProviders={data.unavailableProviders}
					bind:draft={composer.request}
					bind:referenceDraft={composer.references}
					validation={seedream}
					{duplicateWarning}
					{localCopies}
					bind:previewIndex
					focusPreview={() => shell.focusPreview()}
				/>
			{:else if composer.model === "derived" && derivedRow}
				<DerivedImageFields
					bind:draft={composer.request}
					row={derivedRow}
					connected={data.zImageConnected}
					errors={derivedCheck && !derivedCheck.ok ? derivedCheck.errors : {}}
				/>
			{:else if composer.model === "z-image"}
				<ZImageFields
					bind:draft={composer.request}
					bind:privateName={composer.privateName}
					connected={data.zImageConnected}
					promptError={zImage && !zImage.ok ? zImage.errors.prompt : undefined}
				/>
			{/if}
		</div>
	{/snippet}
	{#snippet reviewPanel()}
		{#if reviewOnly}
			<ReviewOnlyPanel row={reviewOnly} headingId={reviewOnlyHeadingId} />
		{/if}
		<div class={setAside} hidden={!!reviewOnly}>
			<ImageReview
				modelId={composerModel}
				connected={composer.model === "seedream-5.5"
					? !!composer.request.provider
					: data.zImageConnected}
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
				provider={composer.model === "seedream-5.5"
					? (composer.request.provider ?? undefined)
					: "poyo"}
				operation={composer.request.operation === "edit" ? "edit" : "generate"}
				catalogRow={derivedRow ? { row: derivedRow, refusedAt } : null}
				{localCopies}
				bind:pending
			/>
		</div>
	{/snippet}
</ImageComposer>
