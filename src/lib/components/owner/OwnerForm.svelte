<script lang="ts">
import tide from "#lib/assets/kestrel-point.jpg";
import { css } from "#styled-system/css";
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

let {
	claim = false,
	pending = false,
	message,
	username = "",
}: { claim?: boolean; pending?: boolean; message?: string; username?: string } = $props();
const title = $derived(
	claim ? "Claim your studio" : pending ? "Verify your sign-in" : "Welcome back",
);
</script>

<svelte:head><title>{title} · Siluet</title></svelte:head>
<main class={entry}>
	<div class={artwork} style:--owner-art={`url("${tide}")`}>
		<Brand />
	</div>
	<div class={content}>
		<form method="POST" class={credentials}>
			<h1
				tabindex="-1"
				{@attach (node) => {
					if (pending && !message) node.focus();
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
						defaultValue={username}
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
			{#if message}
				<p
					class={css({ color: "danger", marginBottom: "0.5rem" })}
					role="alert"
					tabindex="-1"
					{@attach (element) => element.focus()}
				>
					{message}
				</p>
			{/if}
			<button
				class={css({ width: "100%" })}
				type="submit"
				name="action"
				value={pending ? "factor" : "primary"}
			>
				{claim ? "Claim studio" : pending ? "Verify code" : "Sign in"}
			</button>
			{#if pending}
				<button type="submit" name="action" value="cancel" formnovalidate>Cancel</button>
			{/if}
		</form>
	</div>
</main>
