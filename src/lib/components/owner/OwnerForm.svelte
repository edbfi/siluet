<script lang="ts">
import { css } from "#styled-system/css";
import tide from "../../../../design/workspace/media/kestrel-point.jpg";
import Brand from "./Brand.svelte";

let { claim = false, message }: { claim?: boolean; message?: string } = $props();
const title = $derived(claim ? "Claim your studio" : "Welcome back");
</script>

<svelte:head><title>{title} · Siluet</title></svelte:head>
<main class="entry">
	<div
		class="entry-art"
		style:background-image={"linear-gradient(180deg,rgba(17,29,51,.56),transparent 60%),url(" +
			tide +
			")"}
	>
		<Brand />
	</div>
	<div class="entry-main">
		<form method="POST" class="credentials">
			<h1>{title}</h1>
			<p>
				{claim
					? "Enter the token from your Siluet terminal, then choose a username and password."
					: "Sign in to your local studio."}
			</p>
			{#if claim}
				<label
					>Claim token<input
						name="token"
						required
						autocomplete="off"
						autocapitalize="none"
						spellcheck="false"
					></label
				>
			{/if}
			<label
				>Username<input
					name="username"
					required
					autocomplete="username"
					autocapitalize="none"
					spellcheck="false"
				></label
			>
			<label
				>Password<input
					type="password"
					name="password"
					required
					autocomplete={claim ? "new-password" : "current-password"}
					aria-describedby={claim ? "password-hint" : undefined}
				></label
			>
			{#if claim}
				<small id="password-hint">Use at least 15 characters.</small>
			{/if}
			{#if message}
				<p class="error" role="alert" tabindex="-1" {@attach (element) => element.focus()}>
					{message}
				</p>
			{/if}
			<button class={css({ width: "100%" })} type="submit">
				{claim ? "Claim studio" : "Sign in"}
			</button>
		</form>
	</div>
</main>
