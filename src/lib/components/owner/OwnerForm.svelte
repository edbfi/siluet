<script lang="ts">
import { onMount } from "svelte";
import tide from "#lib/assets/kestrel-point.jpg";
import { sessionClient } from "#lib/shared/owner/session-client.ts";
import type { AttemptView } from "#lib/shared/owner/sign-in-attempt.ts";
import { css } from "#styled-system/css";
import { goto } from "$app/navigation";
import Brand from "./Brand.svelte";

const entry = css({
	minHeight: "100svh",
	display: "grid",
	gridTemplateColumns: "minmax(18rem, 43%) 1fr",
	"@media (max-width: 700px)": {
		gridTemplateColumns: "1fr",
		gridTemplateRows: "minmax(6rem, 18svh) 1fr",
	},
});
const artwork = css({
	padding: "clamp(1.25rem, 4vw, 4rem)",
	backgroundColor: "#111d33",
	backgroundImage:
		"linear-gradient(180deg, rgba(17, 29, 51, 0.56), transparent 60%), var(--owner-art)",
	backgroundPosition: "center",
	backgroundSize: "cover",
	"@media (max-width: 700px)": { backgroundPosition: "center 42%" },
});
const content = css({
	display: "grid",
	placeItems: "center",
	padding: "2rem clamp(1.25rem, 5vw, 5rem)",
	"@media (max-width: 700px)": {
		placeItems: "start center",
		paddingBlock: "2rem",
	},
});
const credentials = css({ width: "min(100%, 26rem)", display: "grid", gap: "1rem" });
const field = css({ display: "grid", gap: "0.4rem", fontWeight: "600" });
const input = css({ width: "100%", minHeight: "44px", fontWeight: "400" });
const fields = css({ display: "grid", gap: "1rem", border: "none", padding: "0", margin: "0" });

let { claim = false }: { claim?: boolean } = $props();
// The candidate key, its base and a pending proof live only in this tab's memory.
let view = $state<AttemptView>({ factor: false, busy: false, retry: false, message: null });
let form = $state<HTMLFormElement>();
/** A committed attempt's destination is loading: the form sends nothing more. */
let navigating = $state(false);
const locked = $derived(view.busy || navigating);
const pending = $derived(view.factor);
const title = $derived(
	claim ? "Claim your studio" : pending ? "Verify your sign-in" : "Welcome back",
);
onMount(() => {
	const { attempts } = sessionClient();
	const unsubscribe = attempts.subscribe((next) => {
		// As after a full-page submission, secrets are not kept once a request is refused.
		if (next.message && next.message !== view.message && !next.retry)
			for (const input of form?.querySelectorAll<HTMLInputElement>(
				'input[name="password"], input[name="code"]',
			) ?? [])
				input.value = "";
		view = next;
	});
	attempts.mount(claim);
	return unsubscribe;
});
async function submit(event: SubmitEvent & { currentTarget: HTMLFormElement }) {
	event.preventDefault();
	const data = new FormData(event.currentTarget, event.submitter);
	const field = (name: string) => {
		const value = data.get(name);
		return typeof value === "string" ? value : "";
	};
	// While Retry is offered only Cancel submits: the held fields go through Retry.
	const cancel = pending && field("action") === "cancel";
	if (locked || (view.retry && !cancel)) return;
	const { attempts } = sessionClient();
	const destination = claim
		? await attempts.submit("claim", {
				token: field("token"),
				username: field("username"),
				password: field("password"),
			})
		: pending
			? cancel
				? await attempts.cancel()
				: await attempts.factor(field("code"))
			: await attempts.submit("sign-in", {
					username: field("username"),
					password: field("password"),
				});
	await open(destination);
}
async function retry() {
	if (locked) return;
	await open(await sessionClient().attempts.retry());
}
async function open(destination: string | null) {
	if (!destination) return;
	navigating = true;
	try {
		await goto(destination, { replaceState: true });
	} finally {
		navigating = false;
	}
}
</script>

<svelte:head><title>{title} · Siluet</title></svelte:head>
<main class={entry}>
	<div class={artwork} style:--owner-art={`url("${tide}")`}>
		<Brand />
	</div>
	<div class={content}>
		<form method="POST" class={credentials} onsubmit={submit} aria-busy={locked} bind:this={form}>
			<h1
				tabindex="-1"
				{@attach (node) => {
					if (pending && !view.message) node.focus();
				}}
			>
				{title}
			</h1>
			<p class={css({ color: "muted", marginBottom: "0.5rem" })}>
				{claim
					? "Enter the token from your Siluet terminal, then choose a username and password."
					: pending
						? "Enter an authenticator or unused recovery code. Using your last recovery code leaves only the authenticator for sign-in."
						: "Sign in to your local studio."}
			</p>
			<!-- While Retry is offered, the held fields are what it sends: they cannot change. -->
			<fieldset class={fields} disabled={view.retry}>
				{#if claim}
					<label class={field}
						>Claim token<input
							class={input}
							name="token"
							required
							autocomplete="off"
							autocapitalize="none"
							spellcheck="false"
						></label
					>
				{/if}
				{#if pending}
					<label class={field}
						>Authenticator or recovery code<input
							class={input}
							name="code"
							autocomplete="one-time-code"
							required
							spellcheck="false"
						></label
					>
				{:else}
					<label class={field}
						>Username<input
							class={input}
							name="username"
							required
							autocomplete="username"
							autocapitalize="none"
							spellcheck="false"
						></label
					>
					<label class={field}
						>Password<input
							class={input}
							type="password"
							name="password"
							required
							autocomplete={claim ? "new-password" : "current-password"}
							aria-describedby={claim ? "password-hint" : undefined}
						></label
					>
					{#if claim}
						<small id="password-hint" class={css({ color: "muted", marginTop: "-0.7rem" })}>
							Use at least 15 characters.
						</small>
					{/if}
				{/if}
			</fieldset>
			{#if view.message}
				<p
					class={css({ color: "danger", marginBottom: "0.5rem" })}
					role="alert"
					tabindex="-1"
					{@attach (element) => element.focus()}
				>
					{view.message}
				</p>
			{/if}
			{#if view.retry}
				<button class={css({ width: "100%" })} type="button" onclick={retry} disabled={locked}>
					Retry
				</button>
			{:else}
				<button
					class={css({ width: "100%" })}
					type="submit"
					name="action"
					value={pending ? "factor" : "primary"}
					disabled={locked}
				>
					{claim ? "Claim studio" : pending ? "Verify code" : "Sign in"}
				</button>
			{/if}
			{#if pending}
				<button type="submit" name="action" value="cancel" formnovalidate disabled={locked}>
					Cancel
				</button>
			{/if}
		</form>
	</div>
</main>
