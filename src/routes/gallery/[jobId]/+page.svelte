<script lang="ts">
import { actions, link, page, viewer } from "#lib/components/gallery/gallery-styles.ts";
import SavedImageDetails from "#lib/components/gallery/SavedImageDetails.svelte";
import type { PageProps } from "./$types";

let { data }: PageProps = $props();
const video = $derived(data.image.mime === "video/mp4");
const kind = $derived(video ? "video" : "image");
const href = $derived(`/gallery/${encodeURIComponent(data.image.jobId)}`);
</script>

<svelte:head><title>Saved {kind} · Siluet</title></svelte:head>
<section class={page} aria-labelledby="image-title">
	<a class={link} href="/gallery">Back to Gallery</a>
	<h1 id="image-title">{video ? "Video" : "Image"} {data.image.jobId.slice(0, 8)}</h1>
	{#if data.image.available && video}
		<!-- svelte-ignore a11y_media_has_caption (Creator-generated media has no caption source.) -->
		<!-- biome-ignore lint/a11y/useMediaCaption: Creator-generated media has no caption source. -->
		<video
			controls
			playsinline
			preload="metadata"
			aria-label="Saved video playback"
			class={viewer}
			src={`${href}/media`}
		></video>
	{:else if data.image.available}
		<img
			src={`${href}/media`}
			alt={`Saved image from job ${data.image.jobId.slice(0, 8)}`}
			class={viewer}
			width={data.image.width}
			height={data.image.height}
		>
	{:else}
		<p>The saved {kind} file is unavailable.</p>
	{/if}
	<SavedImageDetails {...data.image} />
	<div class={actions}>
		{#if data.image.available}
			<a class={link} href={`${href}/media?download=1`} download>Download {kind}</a>
		{/if}
		<a class={link} href={`${href}/remove`}>Remove from Gallery</a>
	</div>
</section>
