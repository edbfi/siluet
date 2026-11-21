<script lang="ts">
import {
	caption,
	card,
	grid,
	link,
	page,
	preview,
} from "#lib/components/gallery/gallery-styles.ts";
import SavedImageDetails from "#lib/components/gallery/SavedImageDetails.svelte";
import type { PageProps } from "./$types";

let { data }: PageProps = $props();
</script>

<svelte:head><title>Gallery · Siluet</title></svelte:head>
<section class={page} aria-labelledby="gallery-title">
	<h1 id="gallery-title">Gallery</h1>
	{#if data.images.length}
		<ul class={grid} aria-label="Saved images">
			{#each data.images as image (image.jobId)}
				{@const href = `/gallery/${encodeURIComponent(image.jobId)}`}
				<li>
					<a class={card} {href}>
						<div class={preview}>
							{#if image.available}
								<img src={`${href}/media`} alt="" loading="lazy" decoding="async">
							{:else}
								<span>File unavailable</span>
							{/if}
						</div>
						<div class={caption}>
							<strong>Image {image.jobId.slice(0, 8)}</strong>
							<SavedImageDetails {...image} />
						</div>
					</a>
				</li>
			{/each}
		</ul>
	{:else}
		<p>No saved images yet. Open a completed job and choose <strong>Save to Gallery</strong>.</p>
		<a class={link} href="/jobs">Open Jobs</a>
	{/if}
</section>
