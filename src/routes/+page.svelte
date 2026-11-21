<script lang="ts">
import { onMount } from "svelte";

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
<div class="home">
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
</div>
