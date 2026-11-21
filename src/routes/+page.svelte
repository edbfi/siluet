<script lang="ts">
import { Dialog } from "@ark-ui/svelte/dialog";
import { onMount } from "svelte";
import Brand from "#lib/components/owner/Brand.svelte";

let { data } = $props();
let theme = $state("system");
onMount(() => {
	try {
		theme = localStorage.getItem("siluet-appearance") ?? "system";
	} catch {}
});
$effect(() => {
	document.documentElement.style.colorScheme =
		theme === "light" || theme === "dark" ? theme : "light dark";
});
function saveTheme(event: Event & { currentTarget: HTMLSelectElement }) {
	theme = event.currentTarget.value;
	try {
		localStorage.setItem("siluet-appearance", theme);
	} catch {}
}
</script>
<svelte:head><title>Studio home · Siluet</title></svelte:head>
<a class="skip" href="#home">Skip to workspace</a>
{#snippet navigation()}
	<nav aria-label="Studio navigation"><a href="/" aria-current="page">Studio home</a></nav>
{/snippet}
<div class="workspace">
	<aside class="rail" aria-label="Studio sidebar"><Brand />{@render navigation()}</aside>
	<header class="mobile">
		<Brand />
		<Dialog.Root lazyMount unmountOnExit>
			<Dialog.Trigger>Menu</Dialog.Trigger><Dialog.Backdrop class="scrim" />
			<Dialog.Positioner class="drawer-position"
				><Dialog.Content class="drawer">
					<Dialog.Title>Studio menu</Dialog.Title>
					<Dialog.CloseTrigger>Close menu</Dialog.CloseTrigger>{@render navigation()}
				</Dialog.Content></Dialog.Positioner
			>
		</Dialog.Root>
	</header>
	<main id="home" tabindex="-1" class="home">
		<h1>Studio home</h1>
		<section aria-labelledby="account">
			<h2 id="account">Your workspace</h2>
			<div class="setting">
				<div><span class="caption">Signed in as</span><strong>{data.username}</strong></div>
				<form method="POST" action="?/signout">
					<button type="submit" class="secondary">Sign out</button>
				</form>
			</div>
			<label class="setting"
				>Appearance
				<select value={theme} onchange={saveTheme}>
					<option value="system">System</option>
					<option value="light">Light</option>
					<option value="dark">Dark</option>
				</select>
			</label>
		</section>
	</main>
</div>
