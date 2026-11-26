<script lang="ts">
import {
	downloadPrivate,
	type MediaKind,
	MediaUnavailable,
} from "#lib/components/media/private-media.ts";
import { link, download as styles } from "./gallery-styles.ts";

/** A Gallery Download link that reads the authenticated file and says so while it does. */
let {
	src,
	mime,
	kind,
	name,
	label,
}: { src: string; mime: string; kind: MediaKind; name: string; label: string } = $props();
let phase = $state<"idle" | "pending" | "failed" | "unavailable">("idle");
// The link itself offers the retry, so focus stays where the owner pressed.
const text = $derived(
	phase === "failed" ? `Retry ${label[0].toLowerCase()}${label.slice(1)}` : label,
);
async function start(event: MouseEvent) {
	event.preventDefault();
	// A second click while the file is read changes nothing; `downloadPrivate` would join it.
	if (phase === "pending") return;
	phase = "pending";
	try {
		await downloadPrivate(src, mime, kind, name);
		phase = "idle";
	} catch (error) {
		phase = error instanceof MediaUnavailable ? "unavailable" : "failed";
	}
}
</script>

<div class={styles.group}>
	<a
		class={[link, styles.pending]}
		href={`${src}?download=1`}
		download={name}
		aria-busy={phase === "pending" ? "true" : undefined}
		onclick={start}
		>{text}</a
	>
	<!-- Always rendered, so assistive tech announces the change; empty while idle. -->
	<p class={styles.status} role="status">{phase === "pending" ? "Preparing download…" : ""}</p>
	{#if phase === "failed"}
		<p class={styles.failed} role="alert">The download could not start.</p>
	{:else if phase === "unavailable"}
		<p class={styles.failed} role="alert">This file is no longer available.</p>
	{/if}
</div>
