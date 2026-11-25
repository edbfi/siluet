<script lang="ts">
import { onDestroy, onMount } from "svelte";
import { sessionClient } from "#lib/shared/owner/session-client.ts";
import { css } from "#styled-system/css";
import { enhance, type SubmitFunction } from "$app/forms";
import { page } from "$app/state";
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
const banner = css({
	padding: "0.75rem 1rem",
	borderRadius: "0.5rem",
	backgroundColor: "canvas",
	border: "1px solid {colors.line}",
});

// sessionStorage names this tab's candidate by its digest, so a reload can offer Resume.
const candidateKey = "siluet-security-candidate";
let saved = $state<string | null>(null);
let submitting = $state(false);
let mounted = true;
let secretArea = $state<HTMLElement>();
const offerQuery = $derived(data.offer ? "&offer" : "");
$effect(() => {
	const shown =
		result?.kind === "candidate"
			? result.digest
			: result?.kind === "error" && result.proof
				? result.proof
				: null;
	try {
		if (shown) sessionStorage.setItem(candidateKey, shown);
		else if (result?.kind === "changed" || (page.url.searchParams.has("resume") && !data.candidate))
			sessionStorage.removeItem(candidateKey);
		saved = sessionStorage.getItem(candidateKey);
	} catch {}
});
/** Clear a shown candidate when the page goes, so history cannot reveal its seed. */
function forget() {
	if (!secretArea?.childElementCount) return;
	secretArea.replaceChildren();
	sessionClient().registerDestination(`/settings/security${data.offer ? "?offer" : ""}`);
}
onMount(() => {
	window.addEventListener("pagehide", forget);
	return () => window.removeEventListener("pagehide", forget);
});
onDestroy(() => {
	mounted = false;
});

const submit: SubmitFunction = ({ cancel }) => {
	if (submitting) return cancel();
	submitting = true;
	const client = sessionClient();
	const from = location.href;
	client.beginSecurity();
	return async ({ result: outcome, update }) => {
		try {
			if (outcome.type === "success" && outcome.data?.kind === "changed") {
				// Codes go to the dialog only, never into the form result.
				const changed = outcome.data as { sessionId: string; codes?: string[] };
				const codes = changed.codes ?? [];
				Reflect.deleteProperty(changed, "codes");
				if (client.settleSecurity({ sessionId: changed.sessionId, codes }, mounted, from))
					await update({ reset: true });
				return;
			}
			client.settleSecurity(null, mounted, from);
			if (mounted) await update({ reset: false });
		} finally {
			submitting = false;
		}
	};
};
const choices = [
	["replace", "Replace authenticator"],
	["regenerate", "Regenerate recovery codes"],
	["disable", "Turn off authenticator"],
] as const;
</script>
<svelte:head><title>Security · Siluet</title></svelte:head>
<div class={styles.settings}>
	<h1 class={styles.heading}>Settings</h1>
	<nav class={styles.categories} aria-label="Settings categories">
		<a class={styles.categoryLink} href="/settings/providers">Providers</a
		><a class={styles.categoryLink} href="/settings/security" aria-current="page">Security</a
		><a class={styles.categoryLink} href="/settings/files">Attached files</a>
	</nav>
	<section class={panel}>
		<h2
			tabindex="-1"
			{@attach (node) => {
				if (!result || result.kind === "changed") node.focus();
			}}
		>
			Security
		</h2>
		{#if result?.kind === "error"}
			<p role="alert" tabindex="-1" {@attach (node) => node.focus()}>{result.message}</p>
		{/if}
		{#if result?.kind === "changed"}
			<div class={banner} role="status">
				<p>Security updated. Other sessions have been signed out.</p>
				{#if data.offer}
					<a href="/settings/files?offer">Continue to attached files</a>
				{/if}
			</div>
		{/if}
		{#if result?.kind === "candidate" ||
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
				<form class={fields} method="POST" use:enhance={submit}>
					<input type="hidden" name="change" value={result.action}>
					<input
						type="hidden"
						name="proof"
						value={result.kind === "candidate" ? result.digest : result.proof}
					>
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
					<button type="submit" disabled={submitting}>Confirm authenticator</button>
				</form>
			</div>
			<a href={data.offer ? "/settings/security?offer" : "/settings/security"}
				>Return to Security</a
			>
		{:else}
			{#if saved && !data.candidate}
				<a href={`/settings/security?resume=${saved}${offerQuery}`}>Resume authenticator setup</a>
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
			<form class={fields} method="POST" use:enhance={submit}>
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
					<button type="submit" disabled={submitting}>Continue</button>
				{:else}
					<input type="hidden" name="change" value="enable">
					<button type="submit" disabled={submitting}>Set up authenticator</button>
				{/if}
			</form>
			{#if data.offer && !data.enabled && result?.kind !== "changed"}
				<a href="/settings/files?offer">Skip for now</a>
			{/if}
		{/if}
	</section>
</div>
