<script lang="ts">
import type { MediaDescriptor } from "#lib/shared/media-staging/descriptor.ts";
import type { LocalCopy } from "./local-copy.svelte.ts";
import * as styles from "./local-copy-styles.ts";

let { copy, headingId }: { copy: LocalCopy; headingId: string } = $props();

const resource = (staged: MediaDescriptor) => `/image/files/${staged.draft}/${staged.handle}`;
const caption = $derived.by(() => {
	if (!copy.stage) return "";
	const { mime, size } = copy.stage;
	const rounded =
		size < 1_000_000 ? `${(size / 1000).toFixed(1)} KB` : `${(size / 1_000_000).toFixed(2)} MB`;
	return `${mime === "image/png" ? "PNG" : "JPEG"} · ${rounded} (${size.toLocaleString("en-US")} bytes)`;
});
</script>

<!-- The reference slot announces the cleaning status and offers Try again. Review repeats it as information. -->
<section class={styles.section} aria-labelledby={`${headingId}-local-copy`}>
	<h3 class={styles.heading} id={`${headingId}-local-copy`}>Local copy</h3>
	<p class={styles.note}>
		Siluet cleans a private copy on this computer as soon as you attach the file. Cleaning makes no
		provider calls, and your original file stays unchanged.
	</p>
	{#if copy.status}
		<p class={copy.failed ? styles.failure : styles.note}>{copy.status}</p>
	{/if}
	{#if copy.stage}
		{@const stage = copy.stage}
		<figure class={styles.figure}>
			<img
				class={styles.preview}
				src={resource(stage)}
				alt="Cleaned local copy"
				onload={() => copy.loaded(stage)}
				onerror={() => copy.unavailable(stage)}
			>
			<figcaption class={styles.note}>{caption}</figcaption>
		</figure>
		{#if stage.transform === "reencoded-rotation"}
			<p class={styles.disclosure}>
				<strong>Re-encoded to apply rotation.</strong> The camera orientation was applied to the
				pixels and the image was saved once more as a JPEG at quality 95, which can soften fine
				detail.
			</p>
		{/if}
		<h4 class={styles.subheading} id={`${headingId}-survival`}>What survives cleanup</h4>
		<ul class={styles.list} aria-labelledby={`${headingId}-survival`}>
			<li>
				Removed: EXIF and GPS, XMP and IPTC including authorship and AI-source tags, comments,
				thumbnails, editing history and recognized embedded Content Credentials.
			</li>
			<li>
				Kept: an embedded ICC color profile, exactly. Its creator, copyright, creation date, device
				names, descriptions and private fields can survive.
			</li>
			<li>Watermarks in the picture itself survive.</li>
		</ul>
	{/if}
</section>
