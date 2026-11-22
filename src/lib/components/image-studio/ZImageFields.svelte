<script lang="ts">
import { tick } from "svelte";
import { parseReferenceUrl, publicReferenceUrlError } from "#lib/shared/image-studio/references.ts";
import {
	createZImageDraft,
	type ZImageDraft,
	zImageSizes,
} from "#lib/shared/image-studio/z-image.ts";
import { releasedOperations } from "#lib/shared/media-catalog/registry.ts";
import { css } from "#styled-system/css";
import ImagePrompt from "./ImagePrompt.svelte";
import {
	referenceAction,
	requestControl,
	requestError,
	requestField,
	requestFields,
	requestFieldset,
	requestHelp,
	requestLabel,
	requestLegend,
	requestLink,
} from "./request-styles.ts";

let {
	draft = $bindable(),
	privateName = $bindable(),
	connected,
	promptError,
}: {
	draft: ZImageDraft;
	privateName: string;
	connected: boolean;
	promptError?: string;
} = $props();
const id = $props.id();
const operations = releasedOperations.filter((entry) => entry.modelId === "z-image");
let candidate = $state("");
let urlError = $state("");
let urlField = $state<HTMLInputElement>();
let nameField = $state<HTMLInputElement>();
function switchMode(operation: ZImageDraft["operation"]) {
	draft = createZImageDraft(operation, draft.prompt);
	candidate = "";
	privateName = "";
	urlError = "";
}
async function stage(event: SubmitEvent) {
	event.preventDefault();
	const reference = parseReferenceUrl(candidate);
	if (!reference) {
		urlError = publicReferenceUrlError;
		urlField?.focus();
		return;
	}
	draft.references = [reference];
	candidate = "";
	urlError = "";
	await tick();
	nameField?.focus();
}
async function remove() {
	draft.references = [];
	privateName = "";
	await tick();
	urlField?.focus();
}
</script>
<div class={requestFields}>
	<div class={requestField}>
		<span class={requestLabel}>API provider</span>
		{#if connected}
			<span>Poyo.ai</span>
		{:else}
			<a
				class={css(requestLink, {
					display: "inline-flex",
					alignItems: "center",
					width: "fit-content",
					minHeight: "44px",
				})}
				href="/settings/providers"
				>Connect Poyo.ai in Settings</a
			>
		{/if}
	</div>
	<div class={[requestField, requestLabel]}>
		<label for={`${id}-operation`}>Operation</label>
		<select
			class={requestControl}
			id={`${id}-operation`}
			value={draft.operation}
			onchange={(event) => {
				const entry = operations.find((entry) => entry.mode === event.currentTarget.value);
				if (entry) switchMode(entry.mode);
			}}
		>
			{#each operations as entry (entry.mode)}
				<option value={entry.mode}>{entry.label}</option>
			{/each}
		</select>
	</div>
</div>
{#if draft.operation === "edit"}
	<fieldset class={requestFieldset}>
		<legend class={requestLegend}>Reference image</legend>
		<p class={requestHelp} id={`${id}-help`}>
			Poyo.ai checks the format, size and reachability of one public JPEG, PNG or WebP image up to
			10 MB. Its fetch timing is unknown.
		</p>
		{#if draft.references[0]}
			<p class={css({ overflowWrap: "anywhere" })}>{draft.references[0].hostname} (URL hidden)</p>
			<label class={[requestField, requestLabel]}
				>Private name (optional)
				<input
					class={requestControl}
					bind:this={nameField}
					bind:value={privateName}
					autocomplete="off"
				>
			</label>
			<button class={referenceAction} type="button" onclick={remove}>Remove reference</button>
		{:else}
			<form onsubmit={stage} class={requestField}>
				<label class={[requestField, requestLabel]}
					>Public image URL
					<input
						class={requestControl}
						bind:this={urlField}
						bind:value={candidate}
						oninput={() => (urlError = "")}
						inputmode="url"
						autocomplete="off"
						spellcheck="false"
						aria-invalid={!!urlError}
						aria-describedby={urlError ? `${id}-help ${id}-error` : `${id}-help`}
					>
				</label>
				{#if urlError}
					<p class={requestError} role="status" id={`${id}-error`}>{urlError}</p>
				{/if}
				<button class={referenceAction} type="submit">Use URL</button>
			</form>
		{/if}
	</fieldset>
{/if}
<ImagePrompt
	bind:prompt={draft.prompt}
	operation={draft.operation}
	error={promptError}
	hint="1–1,000 characters"
/>
<div class={[requestField, requestLabel]}>
	<label for={`${id}-size`}>Aspect ratio</label>
	<select
		class={requestControl}
		id={`${id}-size`}
		value={draft.options.size ?? ""}
		onchange={(event) => {
			const size = zImageSizes.find((size) => size === event.currentTarget.value);
			draft.options = size ? { size } : {};
		}}
	>
		{#if draft.operation === "edit"}
			<option value="">Provider default</option>
		{/if}
		{#each zImageSizes as size (size)}
			<option value={size}>{size}</option>
		{/each}
	</select>
</div>
