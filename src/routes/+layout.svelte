<script lang="ts">
import "../app.css";
import { onMount, tick } from "svelte";
import icon from "#lib/assets/siluet-icon.svg";
import RecoveryCodes from "#lib/components/owner/RecoveryCodes.svelte";
import StudioShell from "#lib/components/workspace/StudioShell.svelte";
import { type CodesView, sessionClient } from "#lib/shared/owner/session-client.ts";
import { applyAppearance } from "#lib/shared/styles/appearance.ts";
import { goto } from "$app/navigation";
import { page } from "$app/state";
import type { LayoutProps } from "./$types";

let { children }: LayoutProps = $props();
let remountKey = $state(0);
let menuOpen = $state(false);
// The dialog opens only after the drawer has closed, so no other modal holds the top layer.
let shown = $state<CodesView | null>(null);
const studio = $derived(
	!page.error &&
		(page.url.pathname === "/" ||
			page.url.pathname === "/image" ||
			page.url.pathname === "/video" ||
			page.url.pathname === "/jobs" ||
			page.url.pathname === "/gallery" ||
			page.url.pathname.startsWith("/gallery/") ||
			page.url.pathname.startsWith("/settings/")),
);

onMount(() => {
	try {
		applyAppearance(localStorage.getItem("siluet-appearance"));
	} catch {}
	const client = sessionClient();
	const unsubscribe = client.subscribe(async (state) => {
		remountKey = state.remountKey;
		if (state.codes && !shown) {
			menuOpen = false;
			await tick();
		}
		shown = state.codes;
	});
	// Revalidate when the tab comes back. The one pageshow handler loads a pending destination
	// instead, and checks nothing on that path.
	const visible = () => {
		if (document.visibilityState === "visible") {
			client.visible();
			void client.check();
		} else client.hidden();
	};
	const focus = () => void client.check();
	const pageshow = (event: PageTransitionEvent) => client.pageshow(event.persisted);
	const pagehide = () => client.pagehide();
	addEventListener("focus", focus);
	addEventListener("pageshow", pageshow);
	addEventListener("pagehide", pagehide);
	document.addEventListener("visibilitychange", visible);
	return () => {
		unsubscribe();
		removeEventListener("focus", focus);
		removeEventListener("pageshow", pageshow);
		removeEventListener("pagehide", pagehide);
		document.removeEventListener("visibilitychange", visible);
	};
});
function done() {
	const next = sessionClient().done();
	if (next) void goto(next);
}
</script>

<svelte:head><link rel="icon" href={icon}></svelte:head>
{#key remountKey}
	{#if studio}
		<StudioShell pathname={page.url.pathname} bind:menuOpen> {@render children()} </StudioShell>
	{:else}
		{@render children()}
	{/if}
{/key}
{#if shown}
	<RecoveryCodes codes={shown.codes} notice={shown.notice} ondone={done} />
{/if}
