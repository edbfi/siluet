<script lang="ts">
import { untrack } from "svelte";
import { getImageDraftContext } from "#lib/components/image-studio/draft-context.ts";
import ImageComposer from "#lib/components/image-studio/ImageComposer.svelte";
import { createSeedreamDraft } from "#lib/shared/image-studio/seedream.ts";
import type { PageProps } from "./$types";

let { data }: PageProps = $props();
const memory = getImageDraftContext();
let draft = $state(
	untrack(() => memory.draft ?? createSeedreamDraft(data.eligibleProviders[0] ?? null)),
);

$effect(() => {
	memory.draft = draft;
});
</script>

<svelte:head><title>Image Studio · Siluet</title></svelte:head>
<ImageComposer eligibleProviders={data.eligibleProviders} bind:draft />
