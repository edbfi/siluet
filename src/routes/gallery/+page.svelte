<script lang="ts">
import {
	caption,
	card,
	grid,
	link,
	page,
	preview,
	tile,
} from "#lib/components/gallery/gallery-styles.ts";
import SavedImageDetails from "#lib/components/gallery/SavedImageDetails.svelte";
import type { PageProps } from "./$types";

let { data }: PageProps = $props();
</script>

<svelte:head><title>Gallery · Siluet</title></svelte:head>
<section class={page} aria-labelledby="gallery-title">
	<h1 id="gallery-title">Gallery</h1>
	{#if data.images.length}
		<ul class={grid} aria-label="Saved media">
			{#each data.images as image (image.jobId)}
				{@const href = `/gallery/${encodeURIComponent(image.jobId)}`}
				{@const kind = image.mime === "video/mp4" ? "video" : "image"}
				<li class={tile}>
					<a class={card} {href}>
						<div class={preview}>
							{#if image.available && image.mime === "video/mp4"}
								<span aria-hidden="true">▶</span>
							{:else if image.available}
								<img src={`${href}/media`} alt="" loading="lazy" decoding="async">
							{:else}
								<span>File unavailable</span>
							{/if}
						</div>
						<div class={caption}>
							<strong
								>{image.mime === "video/mp4" ? "Video" : "Image"} {image.jobId.slice(0, 8)}</strong
							>
							<SavedImageDetails {...image} />
						</div>
					</a>
					{#if image.available}
						<!-- A sibling of the card link: an ordinary browser download of the original file. -->
						<a class={link} href={`${href}/media?download=1`} download
							>Download {kind} {image.jobId.slice(0, 8)}</a
						>
					{/if}
				</li>
			{/each}
		</ul>
	{:else}
		<p>No saved media yet. Completed jobs appear here automatically.</p>
		<a class={link} href="/jobs">Open Jobs</a>
	{/if}
</section>
