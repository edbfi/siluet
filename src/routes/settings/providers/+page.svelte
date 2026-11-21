<script lang="ts">
import {
	type ProviderId,
	providerStorageRepairMessage,
} from "#lib/shared/providers/connections.ts";
import { enhance, type SubmitFunction } from "$app/forms";
import { refreshAll } from "$app/navigation";
import { page } from "$app/state";
import type { ActionData, PageProps } from "./$types";

let { data, form }: PageProps = $props();
type Operation = "connect" | "remove";
type ConnectionFeedback = NonNullable<ActionData>;
const feedbackByProvider = $state<Partial<Record<ProviderId, ConnectionFeedback>>>({});
const pendingByProvider = $state<Partial<Record<ProviderId, Operation>>>({});
const names = { poyo: "Poyo.ai", toapis: "ToAPIs" };
const statuses = {
	disconnected: "Disconnected",
	connected: "Connected",
	reconnect: "Reconnect required",
	repair: "Storage repair required",
};
const dateFormat = new Intl.DateTimeFormat("en", {
	dateStyle: "medium",
	timeStyle: "short",
	timeZone: "UTC",
});
const provider = $derived(
	data.providers.find(
		({ id }) => id === (page.url.searchParams.get("provider") ?? form?.provider),
	) ??
		data.providers.find(({ state }) => state === "connected") ??
		data.providers[0],
);
const pending = $derived(provider && pendingByProvider[provider.id]);
const feedback = $derived(
	provider && !pending
		? (feedbackByProvider[provider.id] ?? (form?.provider === provider.id ? form : null))
		: null,
);
const isSuccess = $derived(feedback?.outcome === "connected" || feedback?.outcome === "removed");
const pendingMessages = { connect: "Checking key…", remove: "Removing key…" };

function save(
	id: ProviderId,
	operation: Operation,
): SubmitFunction<ConnectionFeedback, ConnectionFeedback> {
	return ({ formElement, cancel }) => {
		if (pendingByProvider[id]) {
			cancel();
			return;
		}
		pendingByProvider[id] = operation;
		if (operation === "connect") formElement.reset();
		return async ({ result, update }) => {
			try {
				if (
					(result.type === "success" || result.type === "failure") &&
					result.data?.provider === id
				) {
					feedbackByProvider[id] = result.data;
				}
				const refresh =
					result.type === "success" ||
					(result.type === "failure" && result.data?.outcome === "superseded");
				if (formElement.isConnected) {
					await update({ navigate: false, refreshAll: refresh });
				} else if (refresh) {
					// The owner has navigated away. Refresh eligibility at their current destination.
					await refreshAll();
				}
			} finally {
				delete pendingByProvider[id];
			}
		};
	};
}
</script>

<svelte:head><title>Providers · Siluet</title></svelte:head>

<div class="settings">
	<h1>Settings</h1>
	<nav class="categories" aria-label="Settings categories">
		<a href="/settings/providers" aria-current="page">Providers</a>
	</nav>
	<section class="panel" aria-labelledby="providers-title">
		<header>
			<h2 id="providers-title">Provider connections</h2>
			<p>Connect either provider or both to use Seedream 5.5 in Image Studio.</p>
		</header>
		<nav class="provider-links" aria-label="Provider connections">
			{#each data.providers as candidate (candidate.id)}
				<a
					href={`?provider=${candidate.id}`}
					aria-current={candidate.id === provider?.id ? "page" : undefined}
				>
					<span class="mark" aria-hidden="true">{names[candidate.id][0]}</span>{names[candidate.id]}
				</a>
			{/each}
		</nav>
		{#if provider}
			{#key provider.id}
				<div>
					<div class="status-line">
						<h3>Connection status</h3>
						<span class="badge" data-state={provider.state}>{statuses[provider.state]}</span>
					</div>
					{#if provider.state === "connected"}
						<p class="checked">
							Key last accepted
							<time datetime={new Date(provider.verifiedAt).toISOString()}
								>{dateFormat.format(provider.verifiedAt)} UTC</time
							>
						</p>
						{#if !provider.seedream}
							<p class="warning">Seedream 5.5 access unavailable.</p>
						{/if}
					{:else if provider.state === "reconnect"}
						<p class="warning">Enter a key again to restore this connection.</p>
					{/if}
					{#if provider.state === "repair"}
						<p class="warning">{providerStorageRepairMessage}</p>
					{:else}
						<form
							class="key-form"
							method="POST"
							action={`?/connect&provider=${provider.id}`}
							use:enhance={save(provider.id, "connect")}
						>
							<input type="hidden" name="provider" value={provider.id}>
							<label for="provider-key">API key</label>
							<div class="form-controls">
								<input
									id="provider-key"
									type="password"
									name="key"
									autocomplete="off"
									spellcheck="false"
									required
									disabled={!!pending}
									aria-describedby="key-help"
								>
								<button type="submit" disabled={!!pending}>
									{pending === "connect"
										? pendingMessages.connect
										: provider.state === "connected"
											? "Replace key"
											: "Connect"}
								</button>
							</div>
							<p id="key-help">
								Siluet checks the key with {names[provider.id]} when you submit it and stores it
								encrypted on this machine.
							</p>
						</form>
					{/if}
					{#if provider.state === "connected" ||
						provider.state === "reconnect" ||
						(provider.state === "repair" && provider.hasCredential)}
						<form
							class="remove-form"
							method="POST"
							action={`?/remove&provider=${provider.id}`}
							use:enhance={save(provider.id, "remove")}
						>
							<input type="hidden" name="provider" value={provider.id}>
							<button class="secondary" type="submit" disabled={!!pending}>
								{pending === "remove" ? pendingMessages.remove : "Remove key"}
							</button>
						</form>
					{/if}
					<p class="feedback" role="status">
						{pending ? pendingMessages[pending] : isSuccess ? feedback?.message : ""}
					</p>
					<p class="feedback warning" role="alert">
						{feedback && !isSuccess ? feedback.message : ""}
					</p>
				</div>
			{/key}
		{/if}
	</section>
</div>

<style>
.settings {
	max-inline-size: 64rem;
}
h1 {
	margin-block-end: 1.75rem;
	font-size: clamp(2.2rem, 5vw, 3.125rem);
}
.categories {
	margin-block-end: 1rem;
	border-block-end: 1px solid var(--line);
}
.categories a {
	display: inline-grid;
	min-height: 2.75rem;
	place-content: center;
	padding-inline: 0.75rem;
	border-block-end: 2px solid var(--accent);
	color: var(--accent);
	font-size: 0.875rem;
	font-weight: 650;
	text-decoration: none;
}
.categories a:hover {
	background: var(--surface);
}
.panel {
	padding: clamp(1rem, 3vw, 1.375rem);
	border: 1px solid var(--line);
	border-radius: 12px;
	background: var(--surface);
}
h2,
h3 {
	margin: 0;
	font:
		710 1.0625rem / 1.4 system-ui,
		sans-serif;
	letter-spacing: normal;
}
h3 {
	font-size: 0.875rem;
}
.panel p {
	color: var(--muted);
	font-size: 0.875rem;
}
.panel header p {
	margin-block-start: 0.25rem;
}
.provider-links {
	display: flex;
	flex-wrap: wrap;
	gap: 0.5rem;
	margin-block: 1rem;
}
.provider-links a {
	display: inline-flex;
	align-items: center;
	gap: 0.5rem;
	min-height: 2.75rem;
	padding-inline: 0.625rem;
	border: 1px solid var(--border);
	border-radius: 8px;
	color: var(--ink);
	font-size: 0.8125rem;
	font-weight: 650;
	text-decoration: none;
}
.provider-links a:hover {
	background: var(--canvas);
}
.provider-links a[aria-current="page"] {
	border-color: var(--accent);
	background: light-dark(#e8eeff, #293d63);
	color: var(--accent);
}
.mark {
	display: grid;
	place-items: center;
	inline-size: 1.5rem;
	aspect-ratio: 1;
	border-radius: 4px;
	background: var(--canvas);
}
[aria-current="page"] .mark {
	background: var(--surface);
}
.status-line {
	display: flex;
	flex-wrap: wrap;
	align-items: center;
	gap: 0.5rem;
}
.badge {
	padding: 0.1875rem 0.5rem;
	border-radius: 999px;
	background: var(--canvas);
	color: var(--muted);
	font-size: 0.75rem;
	font-weight: 650;
}
.badge[data-state="connected"] {
	background: light-dark(#e4f4ec, #1d3e33);
	color: light-dark(#205c45, #97dfc1);
}
.badge[data-state="reconnect"],
.badge[data-state="repair"] {
	background: light-dark(#fff2d9, #493a25);
	color: light-dark(#754716, #f2cc8a);
}
.checked,
.warning {
	margin-block-start: 0.375rem;
}
.panel .warning {
	color: light-dark(#953528, #ffb7ae);
}
.key-form,
.remove-form {
	margin-block-start: 0.875rem;
	padding-block-start: 0.875rem;
	border-block-start: 1px solid var(--line);
}
.key-form label {
	font-size: 0.875rem;
	font-weight: 650;
}
.form-controls {
	display: grid;
	grid-template-columns: minmax(0, 24rem) auto;
	justify-content: start;
	gap: 0.5rem;
	margin-block: 0.375rem;
}
input,
button {
	min-height: 2.75rem;
}
button {
	font-size: 0.875rem;
}
button:disabled {
	opacity: 0.65;
	cursor: wait;
}
.feedback:not(:empty) {
	margin-block-start: 0.75rem;
}
@media (max-width: 440px) {
	.form-controls {
		grid-template-columns: minmax(0, 1fr);
	}
	.form-controls button {
		justify-self: start;
	}
}
</style>
