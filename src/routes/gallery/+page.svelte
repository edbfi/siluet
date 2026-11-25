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
import { downloadPrivate, privateSource } from "#lib/components/media/private-media.ts";
import { mediaFileName } from "#lib/shared/gallery/file-name.ts";
import type { PageProps } from "./$types";

let { data }: PageProps = $props();
const unavailable = $state<Record<string, boolean>>({});
const failedDownload = $state<Record<string, boolean>>({});
async function download(event: MouseEvent, jobId: string, mime: string) {
	event.preventDefault();
	failedDownload[jobId] = false;
	const kind = mime === "video/mp4" ? "video" : "image";
	try {
		await downloadPrivate(
			`/gallery/${encodeURIComponent(jobId)}/media`,
			mime,
			kind,
			mediaFileName(jobId, mime),
		);
	} catch {
		failedDownload[jobId] = true;
	}
}
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
							{:else if image.available && !unavailable[image.jobId]}
								<img
									alt=""
									decoding="async"
									{@attach privateSource(`${href}/media`, image.mime, "image", {
										failed: () => (unavailable[image.jobId] = true),
										lazy: true,
									})}
								>
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
						<!-- A sibling of the card link: a download of the authenticated original file. -->
						<a
							class={link}
							href={`${href}/media?download=1`}
							download={mediaFileName(image.jobId, image.mime)}
							onclick={(event) => download(event, image.jobId, image.mime)}
							>Download {kind} {image.jobId.slice(0, 8)}</a
						>
						{#if failedDownload[image.jobId]}
							<p role="alert">The download could not start. Retry.</p>
						{/if}
					{/if}
				</li>
			{/each}
		</ul>
	{:else}
		<p>No saved media yet. Completed jobs appear here automatically.</p>
		<a class={link} href="/jobs">Open Jobs</a>
	{/if}
</section>
