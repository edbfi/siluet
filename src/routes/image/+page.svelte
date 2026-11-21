<script lang="ts">
import { untrack } from "svelte";
import { getImageDraftContext } from "#lib/components/image-studio/draft-context.ts";
import ImageComposer from "#lib/components/image-studio/ImageComposer.svelte";
import ImageReview from "#lib/components/image-studio/ImageReview.svelte";
import { createImageReview } from "#lib/shared/image-studio/review.ts";
import {
	buildSeedreamRequest,
	createSeedreamDraft,
	type SeedreamReviewInput,
} from "#lib/shared/image-studio/seedream.ts";
import type { PageProps } from "./$types";

let { data }: PageProps = $props();
const memory = getImageDraftContext();
const headingId = "studio-review-title";
let reviewInput = $state<SeedreamReviewInput | null>(null);
let draft = $state(
	untrack(() => memory.draft ?? createSeedreamDraft(data.eligibleProviders[0] ?? null)),
);

const review = $derived(
	reviewInput &&
		createImageReview(
			reviewInput,
			buildSeedreamRequest(reviewInput, (reference) =>
				reference.kind === "url" ? reference.url : "[local image]",
			),
		),
);

$effect(() => {
	memory.draft = draft;
});
</script>

<svelte:head><title>Image Studio · Siluet</title></svelte:head>
<ImageComposer
	eligibleProviders={data.eligibleProviders}
	bind:draft
	bind:reviewInput
	reviewHref={`#${headingId}`}
>
	{#snippet reviewPanel()}
		<ImageReview
			{review}
			{draft}
			{headingId}
			feeds={data.pricingFeeds}
			nowMs={data.pricingNowMs}
			provider={draft.provider ?? undefined}
			operation={draft.operation}
		/>
	{/snippet}
</ImageComposer>
