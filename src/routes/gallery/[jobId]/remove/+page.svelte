<script lang="ts">
import { actions, link, page } from "#lib/components/gallery/gallery-styles.ts";
import SavedImageDetails from "#lib/components/gallery/SavedImageDetails.svelte";
import { css } from "#styled-system/css";
import { enhance } from "$app/forms";
import type { PageProps } from "./$types";

let { data, form }: PageProps = $props();
</script>

<svelte:head><title>Remove from Gallery · Siluet</title></svelte:head>
<section class={page} aria-labelledby="confirm-title">
	<h1 id="confirm-title">Remove from Gallery?</h1>
	<div>
		<strong
			>{data.image.mime === "video/mp4" ? "Video" : "Image"} {data.image.jobId.slice(0, 8)}</strong
		>
		<SavedImageDetails {...data.image} />
	</div>
	<p>
		This deletes the {data.image.mime === "video/mp4" ? "video" : "image"} from this device. You can
		still find the job in Jobs.
	</p>
	{#if form?.message}
		<p role="alert">{form.message}</p>
	{/if}
	<form method="POST" class={actions} use:enhance>
		<a class={link} href={`/gallery/${encodeURIComponent(data.image.jobId)}`}>Cancel</a>
		<button
			type="submit"
			name="confirm"
			value="remove"
			class={css({ background: "danger", color: "surface" })}
		>
			Remove from Gallery
		</button>
	</form>
</section>
