<script lang="ts">
import { onMount } from "svelte";
import { css } from "#styled-system/css";
import { beforeNavigate } from "$app/navigation";
import { styles } from "../providers/providers-styles";
import type { PageProps } from "./$types";

let { data, form }: PageProps = $props();
const result = $derived(form ?? data.candidate);
const panel = css({
	maxWidth: "40rem",
	display: "grid",
	gap: "1rem",
	padding: "clamp(1rem,4vw,2rem)",
	backgroundColor: "surface",
	borderRadius: "0.75rem",
});
const fields = css({
	display: "grid",
	gap: "1rem",
	"& label": { display: "grid", gap: "0.4rem" },
	"& input": { width: "100%", minHeight: "44px" },
});
const manual = css({ overflowWrap: "anywhere", userSelect: "all", fontFamily: "monospace" });
let secretArea = $state<HTMLElement>();
function forget() {
	if (secretArea) {
		secretArea.replaceChildren();
		for (const script of document.querySelectorAll("script:not([src])")) script.remove();
	}
}
beforeNavigate(forget);
onMount(() => {
	const restored = (event: PageTransitionEvent) => {
		if (event.persisted) location.replace("/settings/security");
	};
	window.addEventListener("pagehide", forget);
	window.addEventListener("pageshow", restored);
	return () => {
		window.removeEventListener("pagehide", forget);
		window.removeEventListener("pageshow", restored);
	};
});
const choices = [
	["replace", "Replace authenticator"],
	["regenerate", "Regenerate recovery codes"],
	["disable", "Turn off authenticator"],
] as const;
</script>
<svelte:head><title>Security · Siluet</title></svelte:head>
<div class={styles.settings} data-sveltekit-reload>
	<h1 class={styles.heading}>Settings</h1>
	<nav class={styles.categories} aria-label="Settings categories">
		<a class={styles.categoryLink} href="/settings/providers">Providers</a
		><a class={styles.categoryLink} href="/settings/security" aria-current="page">Security</a>
	</nav>
	<section class={panel}>
		<h2
			tabindex="-1"
			{@attach (node) => {
				if (!result || (result.kind === "changed" && !result.codes.length)) node.focus();
			}}
		>
			Security
		</h2>
		{#if result?.kind === "error"}
			<p role="alert" tabindex="-1" {@attach (node) => node.focus()}>{result.message}</p>
		{/if}
		{#if result?.kind === "changed"}
			<p role="status">Security updated. Other sessions have been signed out.</p>
			{#if result.codes.length}
				<div bind:this={secretArea}>
					<h3 tabindex="-1" {@attach (node) => node.focus()}>Save your recovery codes</h3>
					<p>Keep these ten single-use codes somewhere private. They are shown once.</p>
					<ul class={manual}>
						{#each result.codes as code (code)}
							<li>{code}</li>
						{/each}
					</ul>
				</div>
			{/if}
			<a href="/settings/security">Done</a>
		{:else if result?.kind === "candidate" ||
			(result?.kind === "error" && result.proof && result.action)}
			<div bind:this={secretArea}>
				{#if result.kind === "candidate"}
					<h3 tabindex="-1" {@attach (node) => node.focus()}>Connect your authenticator</h3>
					<p>Scan the QR code or enter this setup key manually.</p>
					<img
						class={css({ width: "14rem", maxWidth: "100%", imageRendering: "pixelated" })}
						src={result.qr}
						alt="Authenticator setup QR code"
					>
					<p class={manual}><code>{result.manual}</code></p>
				{/if}
				<form class={fields} method="POST">
					<input type="hidden" name="change" value={result.action}>
					<input type="hidden" name="proof" value={result.proof}>
					<label
						>New authenticator code<input
							name="code"
							required
							inputmode="numeric"
							autocomplete="one-time-code"
							pattern={"[0-9]{6}"}
							maxlength="6"
						></label
					>
					<button type="submit">Confirm authenticator</button>
				</form>
			</div>
			<a href="/settings/security">Return to Security</a>
		{:else}
			{#if data.canResume}
				<a href="/settings/security?resume">Resume authenticator setup</a>
			{/if}
			{#if data.enabled}
				<p>
					Authenticator on · {data.remaining} recovery
					{data.remaining === 1 ? "code" : "codes"} remaining.
				</p>
				{#if data.remaining === 1}
					<p>
						Using the final recovery code leaves your authenticator as the only factor until you
						generate a new set.
					</p>
				{/if}
			{:else}
				<p>Add an authenticator to require a one-time code when you sign in.</p>
			{/if}
			<form class={fields} method="POST">
				<label
					>Current password<input
						type="password"
						name="password"
						required
						autocomplete="current-password"
					></label
				>
				{#if data.enabled}
					<label
						>Authenticator or recovery code<input
							name="code"
							required
							autocomplete="one-time-code"
							spellcheck="false"
						></label
					>
					<label
						>Security action<select name="change">
							{#each choices as [value, label] (value)}
								<option {value}>{label}</option>
							{/each}
						</select></label
					>
					<button type="submit">Continue</button>
				{:else}
					<input type="hidden" name="change" value="enable">
					<button type="submit">Set up authenticator</button>
				{/if}
			</form>
			{#if data.offer && !data.enabled}
				<a href="/">Skip for now</a>
			{/if}
		{/if}
	</section>
</div>
