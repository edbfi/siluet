<script lang="ts">
import Brand from "#lib/components/owner/Brand.svelte";
import { css } from "#styled-system/css";
import { page } from "$app/state";

// Access failures carry Retry or host-recovery guidance; a signed-out tab carries where to go.
const error = $derived(page.error);
const frame = css({
	minHeight: "100svh",
	display: "grid",
	placeContent: "center",
	gap: "1rem",
	padding: "2rem clamp(1.25rem, 5vw, 5rem)",
	maxWidth: "40rem",
	marginInline: "auto",
});
</script>

<svelte:head><title>Studio access · Siluet</title></svelte:head>
<main class={frame}>
	<Brand />
	<h1>{page.status === 404 ? "Not found" : "Studio access"}</h1>
	<p role="alert">{error?.message ?? "The studio could not complete the request."}</p>
	{#if error?.location}
		<a href={error.location}>Sign in</a>
	{:else if error?.retry}
		<a href={page.url.href} data-sveltekit-reload>Retry</a>
	{:else if !error?.recoveryRequired}
		<a href="/">Open the studio</a>
	{/if}
</main>
