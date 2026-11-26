<script lang="ts">
import { downloadPrivate, type MediaKind } from "#lib/components/media/private-media.ts";
import { link, download as styles } from "./gallery-styles.ts";

/** A Gallery Download link that reads the authenticated file and says so while it does. */
let {
	src,
	mime,
	kind,
	name,
	label,
}: { src: string; mime: string; kind: MediaKind; name: string; label: string } = $props();
let phase = $state<"idle" | "pending" | "failed">("idle");
async function start(event: MouseEvent) {
	event.preventDefault();
	// A second click while the file is read changes nothing; `downloadPrivate` would join it.
	if (phase === "pending") return;
	phase = "pending";
	try {
		await downloadPrivate(src, mime, kind, name);
		phase = "idle";
	} catch {
		phase = "failed";
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
		>{label}</a
	>
	<!-- Always rendered, so assistive tech announces the change; empty while idle. -->
	<p class={styles.status} role="status">{phase === "pending" ? "Preparing download…" : ""}</p>
	{#if phase === "failed"}
		<p class={styles.failed} role="alert">The download could not start. Retry.</p>
	{/if}
</div>
