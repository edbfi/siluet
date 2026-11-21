<script lang="ts">
import "../app.css";
import { onMount } from "svelte";
import icon from "#lib/assets/siluet-icon.svg";
import StudioShell from "#lib/components/workspace/StudioShell.svelte";
import { page } from "$app/state";
import type { LayoutProps } from "./$types";

let { data, children }: LayoutProps = $props();
onMount(() => {
	try {
		const theme = localStorage.getItem("siluet-appearance");
		if (theme === "light" || theme === "dark") document.documentElement.style.colorScheme = theme;
	} catch {}
});
</script>

<svelte:head><link rel="icon" href={icon}></svelte:head>
{#if data.username &&
	(page.url.pathname === "/" ||
		page.url.pathname === "/image" ||
		page.url.pathname.startsWith("/settings/"))}
	<StudioShell pathname={page.url.pathname} signOutGeneration={data.signOutGeneration}>
		{@render children()}
	</StudioShell>
{:else}
	{@render children()}
{/if}
