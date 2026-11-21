<script lang="ts">
import { actions, link, page, viewer } from "#lib/components/gallery/gallery-styles.ts";
import SavedImageDetails from "#lib/components/gallery/SavedImageDetails.svelte";
import type { PageProps } from "./$types";

let { data }: PageProps = $props();
const href = $derived(`/gallery/${encodeURIComponent(data.image.jobId)}`);
</script>

<svelte:head><title>Saved image · Siluet</title></svelte:head>
<section class={page} aria-labelledby="image-title">
	<a class={link} href="/gallery">Back to Gallery</a>
	<h1 id="image-title">Image {data.image.jobId.slice(0, 8)}</h1>
	{#if data.image.available}
		<img
			src={`${href}/media`}
			alt={`Generated image from job ${data.image.jobId.slice(0, 8)}`}
			class={viewer}
			width={data.image.width}
			height={data.image.height}
		>
	{:else}
		<p>The saved image file is unavailable.</p>
	{/if}
	<SavedImageDetails {...data.image} />
	<div class={actions}>
		{#if data.image.available}
			<a class={link} href={`${href}/media?download=1`} download>Download image</a>
		{/if}
		<a class={link} href={`${href}/remove`}>Remove from Gallery</a>
	</div>
</section>
