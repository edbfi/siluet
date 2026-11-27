<script lang="ts">
import { onMount } from "svelte";
import { sessionClient } from "#lib/shared/owner/session-client.ts";
import { applyAppearance } from "#lib/shared/styles/appearance.ts";
import { css, cx } from "#styled-system/css";
import { studioButton, studioPanel } from "#styled-system/recipes";

const panel = cx(
	studioPanel(),
	css({
		borderRadius: "12px",
		marginTop: "2rem",
		padding: "clamp(1rem, 3vw, 2rem)",
	}),
);
const setting = css({
	display: "flex",
	alignItems: "center",
	justifyContent: "space-between",
	gap: "1rem",
	padding: "1.15rem 0",
	overflowWrap: "anywhere",
});
const appearance = cx(setting, css({ borderTop: "1px solid {colors.line}", paddingBottom: "0" }));

let { data } = $props();
let theme = $state("system");
let signingOut = $state(false);
let signOutProblem = $state<"other" | "retry" | null>(null);
async function signOut() {
	signingOut = true;
	signOutProblem = null;
	try {
		const outcome = await sessionClient().signOut();
		if (outcome !== "signed-out") signOutProblem = outcome;
	} finally {
		signingOut = false;
	}
}
onMount(() => {
	// A sign-out that found another sign-in left this offer for the session it joined.
	if (sessionClient().takeSignOutOffer()) signOutProblem = "other";
	try {
		theme = localStorage.getItem("siluet-appearance") ?? "system";
		applyAppearance(theme);
	} catch {}
});
function saveTheme(event: Event & { currentTarget: HTMLSelectElement }) {
	theme = event.currentTarget.value;
	applyAppearance(theme);
	try {
		localStorage.setItem("siluet-appearance", theme);
	} catch {}
}
</script>
<svelte:head><title>Studio home · Siluet</title></svelte:head>
<div class={css({ width: "min(100%, 65rem)" })}>
	<h1>Studio home</h1>
	<section class={panel} aria-labelledby="account">
		<h2 id="account">Your workspace</h2>
		<div class={setting}>
			<div>
				<span class={css({ display: "block", color: "muted" })}>Signed in as</span>
				<strong class={css({ display: "block" })}>{data.username}</strong>
			</div>
			<button
				type="button"
				class={studioButton({ appearance: "secondary" })}
				disabled={signingOut}
				onclick={signOut}
			>
				Sign out
			</button>
		</div>
		{#if signOutProblem}
			<p role="alert" class={css({ color: "danger" })}>
				{signOutProblem === "other"
					? "This browser signed in again since. Sign out again to end that session."
					: "Sign-out did not finish. Retry."}
			</p>
		{/if}
		<label class={appearance}
			>Appearance
			<select value={theme} onchange={saveTheme}>
				<option value="system">System</option>
				<option value="light">Light</option>
				<option value="dark">Dark</option>
			</select>
		</label>
	</section>
</div>
