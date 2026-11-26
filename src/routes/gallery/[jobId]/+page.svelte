<script lang="ts">
import type { Attachment } from "svelte/attachments";
import { link, meta, page, viewer, viewerActions } from "#lib/components/gallery/gallery-styles.ts";
import PrivateDownload from "#lib/components/gallery/PrivateDownload.svelte";
import { playability } from "#lib/components/gallery/playability.ts";
import SavedImageDetails from "#lib/components/gallery/SavedImageDetails.svelte";
import { privateSource } from "#lib/components/media/private-media.ts";
import { mediaFileName } from "#lib/shared/gallery/file-name.ts";
import type { PageProps } from "./$types";

let { data }: PageProps = $props();
const video = $derived(data.image.mime === "video/mp4");
const kind = $derived(video ? "video" : "image");
const href = $derived(`/gallery/${encodeURIComponent(data.image.jobId)}`);
// The job whose clip this browser cannot play; another item starts without the note.
let failed = $state<string | null>(null);
const unplayable = $derived(failed === data.image.jobId);
/** Watch one job's player; its reports concern that job only, and its note goes with it. */
const watch =
	(job: string): Attachment<HTMLVideoElement> =>
	(video) => {
		const detach = playability((cannot) => {
			if (cannot) failed = job;
			else if (failed === job) failed = null;
		})(video);
		return () => {
			detach?.();
			if (failed === job) failed = null;
		};
	};
// The saved file could not be read through this session, or exceeds the page's limit.
let missing = $state<string | null>(null);
</script>

<svelte:head><title>Saved {kind} · Siluet</title></svelte:head>
<section class={page} aria-labelledby="image-title">
	<a class={link} href="/gallery">Back to Gallery</a>
	<h1 id="image-title">{video ? "Video" : "Image"} {data.image.jobId.slice(0, 8)}</h1>
	{#if data.image.available && missing === data.image.jobId}
		<p role="status">The saved {kind} could not be opened here. Download it, or reload to retry.</p>
	{:else if data.image.available && video}
		<!-- Each job gets its own player: its playback watch and timers end with the job. -->
		{#key data.image.jobId}
			<!-- svelte-ignore a11y_media_has_caption (Creator-generated media has no caption source.) -->
			<!-- biome-ignore lint/a11y/useMediaCaption: Creator-generated media has no caption source. -->
			<video
				controls
				playsinline
				preload="metadata"
				aria-label="Saved video playback"
				class={viewer}
				{@attach privateSource(`${href}/media`, data.image.mime, "video", {
					failed: () => (missing = data.image.jobId),
				})}
				{@attach watch(data.image.jobId)}
			></video>
		{/key}
		<p class={meta} role="status">
			{#if unplayable}
				This browser can't play this video. Download it to open it in another player.
			{/if}
		</p>
	{:else if data.image.available}
		<img
			{@attach privateSource(`${href}/media`, data.image.mime, "image", {
				failed: () => (missing = data.image.jobId),
			})}
			alt={`Saved image from job ${data.image.jobId.slice(0, 8)}`}
			class={viewer}
			width={data.image.width}
			height={data.image.height}
		>
	{:else}
		<p>The saved {kind} file is unavailable.</p>
	{/if}
	<SavedImageDetails {...data.image} />
	<div class={viewerActions}>
		{#if data.image.available}
			{#key data.image.jobId}
				<PrivateDownload
					src={`${href}/media`}
					mime={data.image.mime}
					{kind}
					name={mediaFileName(data.image.jobId, data.image.mime)}
					label={`Download ${kind}`}
				/>
			{/key}
		{/if}
		<a class={link} href={`${href}/remove`}>Remove from Gallery</a>
	</div>
</section>
