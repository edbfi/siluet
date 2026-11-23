<script lang="ts">
import { onMount, untrack } from "svelte";
import { css } from "#styled-system/css";
import { applyAction, enhance } from "$app/forms";
import { styles } from "../providers/providers-styles";
import type { PageProps } from "./$types";

let { data, form }: PageProps = $props();
// The stored value and revision this tab last saw. A save or a conflict updates them in place.
let stored = $state.raw(untrack(() => ({ enabled: data.enabled, revision: data.revision })));
let enabled = $state(untrack(() => data.enabled));
let status = $state<string | null>(null);
let enhanced = $state(false);
let pending = $state(false);
let element: HTMLFormElement;
$effect(() => {
	// A full load (no-JS submission or navigation) brings the stored value.
	stored = { enabled: data.enabled, revision: data.revision };
	enabled = data.enabled;
});
$effect(() => {
	if (form && "revision" in form && typeof form.revision === "number") {
		stored = { enabled: !!form.enabled, revision: form.revision };
		enabled = !!form.enabled;
	}
	status = form?.message ?? null;
});
onMount(() => {
	enhanced = true;
});
const panel = css({
	maxWidth: "40rem",
	display: "grid",
	gap: "1rem",
	padding: "clamp(1rem,4vw,2rem)",
	backgroundColor: "surface",
	borderRadius: "0.75rem",
});
const toggle = css({
	display: "flex",
	alignItems: "center",
	gap: "0.75rem",
	minHeight: "44px",
	fontWeight: 650,
	"& input": { inlineSize: "1.25rem", blockSize: "1.25rem", accentColor: "token(colors.accent)" },
});
const note = css({ color: "muted", fontSize: "0.875rem" });
const action = css({ justifySelf: "start", minHeight: "44px", paddingInline: "1rem" });
</script>

<svelte:head><title>Attached files · Siluet</title></svelte:head>
<div class={styles.settings}>
	<h1 class={styles.heading}>Settings</h1>
	<nav class={styles.categories} aria-label="Settings categories">
		<a class={styles.categoryLink} href="/settings/providers">Providers</a
		><a class={styles.categoryLink} href="/settings/security">Security</a
		><a class={styles.categoryLink} href="/settings/files" aria-current="page">Attached files</a>
	</nav>
	<section class={panel} aria-labelledby="attached-files-title">
		<h2 id="attached-files-title">Attached files</h2>
		<form
			method="POST"
			bind:this={element}
			class={css({ display: "grid", gap: "1rem" })}
			use:enhance={() => {
				pending = true;
				return async ({ result }) => {
					pending = false;
					if (result.type === "redirect") return applyAction(result);
					if ((result.type === "success" || result.type === "failure") && result.data) {
						const saved = result.data as { enabled?: boolean; revision?: number; message?: string };
						if (typeof saved.revision === "number") {
							stored = { enabled: !!saved.enabled, revision: saved.revision };
							enabled = stored.enabled;
						}
						status = saved.message ?? null;
						return;
					}
					status = "Siluet could not save this setting. Try again.";
				};
			}}
		>
			<input type="hidden" name="expectedRevision" value={stored.revision}>
			<label class={toggle}>
				<input
					type="checkbox"
					role="switch"
					aria-checked={enabled}
					name="enabled"
					bind:checked={enabled}
					aria-describedby="attached-files-effect attached-files-review"
					disabled={pending}
					onchange={() => {
						if (!data.offer) element.requestSubmit();
					}}
				>
				Remove metadata before upload
			</label>
			<p id="attached-files-effect" class={note}>
				{#if enabled}
					Siluet sends only a cleaned private copy, without location, camera, authorship or
					AI-source tags. An embedded color profile stays; its creator, copyright and device fields
					can survive.
				{:else}
					Siluet sends each file exactly as attached, including that metadata. Files are still
					checked on this computer first.
				{/if}
			</p>
			<p id="attached-files-review" class={note}>
				Changing this needs a new Review; jobs already queued keep the file they reviewed.
			</p>
			{#if data.offer}
				<button class={action} type="submit" disabled={pending}>Continue to studio</button>
			{:else if !enhanced}
				<button class={action} type="submit">Save</button>
			{/if}
			<p class={note} role="status">{status ?? ""}</p>
		</form>
	</section>
</div>
