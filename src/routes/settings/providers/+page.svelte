<script lang="ts">
import {
	type ProviderId,
	providerStorageRepairMessage,
} from "#lib/shared/providers/connections.ts";
import { cx } from "#styled-system/css";
import { studioButton, studioPanel } from "#styled-system/recipes";
import { applyAction, enhance, type SubmitFunction } from "$app/forms";
import { refreshAll } from "$app/navigation";
import { page } from "$app/state";
import type { ActionData, PageProps } from "./$types";
import { styles } from "./providers-styles.ts";

let { data, form }: PageProps = $props();
type Operation = "connect" | "remove";
type ConnectionFeedback = NonNullable<ActionData>;
const feedbackByProvider = $state<Partial<Record<ProviderId, ConnectionFeedback>>>({});
let lastSubmitted = $state<ProviderId>();
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
		({ id }) => id === (page.url.searchParams.get("provider") ?? lastSubmitted ?? form?.provider),
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
// A section's outcome is announced only after its own Check again, until the key changes.
type InventoryScope = "image" | "video";
type InventoryFeedback = { ok: boolean; message: string };
const inventoryFeedback = $state<Partial<Record<InventoryScope, InventoryFeedback>>>({});
const checkingInventory = $state<Partial<Record<InventoryScope, boolean>>>({});
const inventorySections = [
	{ scope: "image", title: "Image models", action: "Check again: image models" },
	{ scope: "video", title: "Video models", action: "Check again: video models" },
] as const;
const statusWords = { listed: "listed", absent: "absent", unknown: "unknown" };

async function checkInventory(scope: InventoryScope) {
	if (checkingInventory[scope]) return;
	checkingInventory[scope] = true;
	try {
		const response = await fetch("/providers/inventory", {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ scope }),
		});
		const answer: { outcome?: string; ok?: boolean; message?: string } | null = await response
			.json()
			.catch(() => null);
		if (answer?.outcome === "recorded" || answer?.outcome === "superseded") await refreshAll();
		// A recorded check shows its section's refreshed line; any other answer says why.
		inventoryFeedback[scope] = {
			ok: answer?.ok === true,
			message:
				answer?.outcome === "recorded"
					? ""
					: typeof answer?.message === "string"
						? answer.message
						: "The model check is unavailable. Try again.",
		};
	} catch {
		inventoryFeedback[scope] = { ok: false, message: "The model check is unavailable. Try again." };
	} finally {
		delete checkingInventory[scope];
	}
}
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
		lastSubmitted = id;
		pendingByProvider[id] = operation;
		if (id === "toapis")
			for (const scope of ["image", "video"] as const) delete inventoryFeedback[scope];
		if (operation === "connect") formElement.reset();
		return async ({ result, update }) => {
			try {
				if (result.type === "success" || result.type === "failure") {
					if (result.data?.provider === id) feedbackByProvider[id] = result.data;
					if (
						result.type === "success" ||
						result.data?.outcome === "superseded" ||
						result.data?.outcome === "job-warning"
					) {
						const hadFocus = formElement.contains(document.activeElement);
						await refreshAll();
						if (
							hadFocus &&
							!formElement.isConnected &&
							provider?.id === id &&
							document.activeElement === document.body
						) {
							document.getElementById("connection-feedback")?.focus({ preventScroll: true });
						}
					}
				} else if (result.type === "redirect") {
					// A session that ended navigates even after a remount removed this form.
					await applyAction(result);
				} else if (formElement.isConnected) {
					await update({ navigate: false });
				}
			} finally {
				delete pendingByProvider[id];
			}
		};
	};
}
</script>

<svelte:head><title>Providers · Siluet</title></svelte:head>

<div class={styles.settings}>
	<h1 class={styles.heading}>Settings</h1>
	<nav class={styles.categories} aria-label="Settings categories">
		<a class={styles.categoryLink} href="/settings/providers" aria-current="page">Providers</a>
		<a class={styles.categoryLink} href="/settings/security">Security</a
		><a class={styles.categoryLink} href="/settings/files">Attached files</a>
	</nav>
	<section class={cx(studioPanel(), styles.panel)} aria-labelledby="providers-title">
		<header>
			<h2 class={styles.panelHeading} id="providers-title">Provider connections</h2>
			<p class={cx(styles.paragraph, styles.intro)}>
				Connect Poyo.ai for Z-Image. Seedream 5.5 is available through either provider.
			</p>
		</header>
		<nav class={styles.providerLinks} aria-label="Provider connections">
			{#each data.providers as candidate (candidate.id)}
				<a
					class={styles.providerLink}
					href={`?provider=${candidate.id}`}
					aria-current={candidate.id === provider?.id ? "page" : undefined}
				>
					<span class={styles.mark} aria-hidden="true">{names[candidate.id][0]}</span>
					{names[candidate.id]}
				</a>
			{/each}
		</nav>
		{#if provider}
			{#key provider.id}
				<div>
					<div class={styles.statusLine}>
						<h3 class={styles.statusHeading}>Connection status</h3>
						<span class={styles.badge} data-state={provider.state}>{statuses[provider.state]}</span>
					</div>
					{#if provider.state === "connected"}
						<p class={cx(styles.paragraph, styles.notice)}>
							Key last accepted
							<time datetime={new Date(provider.verifiedAt).toISOString()}
								>{dateFormat.format(provider.verifiedAt)} UTC</time
							>
						</p>
						{#if provider.id === "toapis" && data.inventory}
							{#each inventorySections as section (section.scope)}
								{@const current = data.inventory[section.scope]}
								{@const announced = inventoryFeedback[section.scope]}
								<section class={styles.inventory} aria-labelledby={`inventory-${section.scope}`}>
									<h3 class={styles.statusHeading} id={`inventory-${section.scope}`}>
										{section.title}
									</h3>
									<p
										class={cx(styles.paragraph, announced && !announced.ok && styles.warning)}
										role={announced ? (announced.ok ? "status" : "alert") : undefined}
									>
										{announced?.message || current.line}
									</p>
									<div class={styles.inventoryActions}>
										<button
											type="button"
											class={cx(studioButton({ appearance: "secondary" }), styles.action)}
											aria-label={checkingInventory[section.scope]
												? section.action.replace("Check again", "Checking")
												: section.action}
											aria-disabled={!!checkingInventory[section.scope]}
											onclick={() => checkInventory(section.scope)}
										>
											{checkingInventory[section.scope] ? "Checking…" : "Check again"}
										</button>
									</div>
									<details class={styles.disclosure}>
										<summary>Every ToAPIs {section.scope} model ({current.models.length})</summary>
										<ul class={styles.modelList}>
											{#each current.models as model (model.id)}
												<li>
													<code>{model.id}</code>
													<span class={styles.modelStatus} data-status={model.status}
														>· {statusWords[model.status]}</span
													>
												</li>
											{/each}
										</ul>
										<p class={styles.paragraph}>{current.caveat}</p>
									</details>
								</section>
							{/each}
						{:else if !provider.seedream}
							<p class={cx(styles.warning, styles.notice)}>Seedream 5.5 access unavailable.</p>
						{/if}
					{:else if provider.state === "reconnect"}
						<p class={cx(styles.warning, styles.notice)}>
							Enter a key again to restore this connection.
						</p>
					{/if}
					{#if provider.neededByJobs}
						<p class={cx(styles.warning, styles.notice)} id="job-key-warning">
							Jobs still need this key. Replacing or removing it pauses status checks and stops
							downloads of their unsaved results. It also stops future submissions in any open
							batch, including batches waiting for cooldown or settlement. An active upload or edit
							finishes using the reviewed key.
						</p>
					{/if}
					{#if provider.state === "repair"}
						<p class={cx(styles.warning, styles.notice)}>{providerStorageRepairMessage}</p>
					{:else}
						<form
							class={styles.form}
							method="POST"
							action={`?/connect&provider=${provider.id}`}
							use:enhance={save(provider.id, "connect")}
						>
							<input type="hidden" name="provider" value={provider.id}>
							{#if provider.neededByJobs}
								<input type="hidden" name="jobWarning" value="seen">
							{/if}
							<label class={styles.label} for="provider-key">API key</label>
							<div class={styles.formControls}>
								<input
									class={styles.input}
									id="provider-key"
									type="password"
									name="key"
									autocomplete="off"
									spellcheck="false"
									required
									readonly={!!pending}
									aria-describedby="key-help"
								>
								<button
									class={cx(styles.action, styles.connect)}
									type="submit"
									aria-disabled={!!pending}
									aria-describedby={provider.neededByJobs ? "job-key-warning" : undefined}
								>
									{pending === "connect"
										? pendingMessages.connect
										: provider.state === "connected"
											? "Replace key"
											: "Connect"}
								</button>
							</div>
							<p class={styles.paragraph} id="key-help">
								Siluet checks the key with {names[provider.id]} when you submit it and stores it
								encrypted on this machine.
							</p>
						</form>
					{/if}
					{#if provider.state === "connected" ||
						provider.state === "reconnect" ||
						(provider.state === "repair" && provider.hasCredential)}
						<form
							class={styles.form}
							method="POST"
							action={`?/remove&provider=${provider.id}`}
							use:enhance={save(provider.id, "remove")}
						>
							<input type="hidden" name="provider" value={provider.id}>
							{#if provider.neededByJobs}
								<input type="hidden" name="jobWarning" value="seen">
							{/if}
							<button
								class={cx(studioButton({ appearance: "secondary" }), styles.action)}
								type="submit"
								aria-disabled={!!pending}
								aria-describedby={provider.neededByJobs ? "job-key-warning" : undefined}
							>
								{pending === "remove" ? pendingMessages.remove : "Remove key"}
							</button>
						</form>
					{/if}
					<p
						class={cx(styles.feedback, styles.paragraph)}
						role="status"
						tabindex="-1"
						id="connection-feedback"
					>
						{pending ? pendingMessages[pending] : isSuccess ? feedback?.message : ""}
					</p>
					<p class={cx(styles.feedback, styles.warning, styles.notice)} role="alert">
						{feedback && !isSuccess ? feedback.message : ""}
					</p>
				</div>
			{/key}
		{/if}
	</section>
</div>
