<script lang="ts">
import { onDestroy, tick } from "svelte";
import {
	checkReferenceFile,
	parseReferenceUrl,
	publicReferenceUrlError,
	referenceFileAccept,
	type SeedreamReference,
} from "#lib/shared/image-studio/references.ts";
import type { SeedreamProvider } from "#lib/shared/image-studio/seedream.ts";

let {
	provider,
	index,
	reference,
	fileId,
	helpId,
	onSelect,
	onRemove,
	onPreview,
}: {
	provider: SeedreamProvider;
	index: number;
	reference: SeedreamReference | undefined;
	fileId: string;
	helpId: string;
	onSelect: (reference: SeedreamReference) => void;
	onRemove: () => void;
	onPreview: () => void;
} = $props();

const id = $props.id();
let fileInput: HTMLInputElement;
let urlField: HTMLInputElement;
let urlDisclosure: HTMLDetailsElement;
let url = $state("");
let error = $state("");
let pending = $state(false);
let selection = 0;
const label = $derived(`Reference image ${index + 1}`);

onDestroy(() => {
	selection++;
});

async function chooseFile(event: Event & { currentTarget: HTMLInputElement }) {
	const file = event.currentTarget.files?.[0];
	event.currentTarget.value = "";
	if (!file) return;

	const currentSelection = ++selection;
	error = "";
	pending = true;
	const result = await checkReferenceFile(provider, file);
	if (selection !== currentSelection) return;
	pending = false;
	if (result) {
		error = result;
		return;
	}
	onSelect({ kind: "file", file });
	url = "";
	urlDisclosure.open = false;
}

async function chooseUrl() {
	const reference = parseReferenceUrl(url);
	if (!reference) {
		error = publicReferenceUrlError;
		urlField.focus();
		return;
	}

	selection++;
	pending = false;
	error = "";
	onSelect(reference);
	url = "";
	urlDisclosure.open = false;
	await tick();
	fileInput?.focus({ preventScroll: true });
}
</script>

<div class="reference" class:separated={index > 0}>
	<label class="title" for={fileId}>{label}</label>
	<div class="file-picker">
		<span class="file-button" aria-hidden="true">
			{reference?.kind === "file" ? "Replace file" : "Choose file"}
		</span>
		{#if reference?.kind === "file"}
			<span class="filename" id={`${id}-name`}>{reference.file.name}</span>
		{/if}
		<input
			bind:this={fileInput}
			id={fileId}
			type="file"
			accept={referenceFileAccept(provider)}
			aria-describedby={`${helpId} ${id}-status${reference?.kind === "file" ? ` ${id}-name` : ""}`}
			onchange={chooseFile}
		>
	</div>
	{#if reference}
		<div class="actions">
			{#if reference.kind === "url"}
				<span>{reference.hostname} (URL hidden)</span>
			{:else}
				<button type="button" onclick={onPreview} aria-label={`Preview ${label.toLowerCase()}`}>
					Preview
				</button>
			{/if}
			<button type="button" onclick={onRemove} aria-label={`Remove ${label.toLowerCase()}`}>
				Remove
			</button>
		</div>
	{/if}

	<details bind:this={urlDisclosure}>
		<summary>Use a URL</summary>
		<label class="url-label" for={`${id}-url`}>HTTP or HTTPS URL for {label.toLowerCase()}</label>
		<div class="url">
			<input
				bind:this={urlField}
				bind:value={url}
				id={`${id}-url`}
				type="text"
				inputmode="url"
				autocomplete="off"
				autocapitalize="none"
				spellcheck="false"
				aria-describedby={`${id}-status`}
				onkeydown={(event) => {
					if (event.key === "Enter") {
						event.preventDefault();
						void chooseUrl();
					}
				}}
			>
			<button type="button" onclick={chooseUrl}>Use URL</button>
		</div>
	</details>

	<p class:error role="status" id={`${id}-status`}>{error || (pending ? "Checking file…" : "")}</p>
</div>

<style>
.reference {
	display: grid;
	gap: 0.3rem;
	min-width: 0;
	padding-block: 0.75rem;
}
.separated {
	border-top: 1px solid var(--line);
}
.title,
.url-label {
	font-size: 0.85rem;
	font-weight: 650;
}
.file-picker {
	position: relative;
	display: flex;
	align-items: center;
	min-height: 44px;
	gap: 0.65rem;
	padding: 0.25rem;
	border: 1px dashed var(--border);
	border-radius: 8px;
	font-size: 0.85rem;
}
.file-picker input {
	position: absolute;
	inset: 0;
	width: 100%;
	height: 100%;
	opacity: 0;
	cursor: pointer;
}
.file-picker:has(:focus-visible) {
	outline: 3px solid var(--accent);
	outline-offset: 3px;
}
.file-button {
	flex: none;
	border-radius: 5px;
	background: var(--canvas);
	padding: 0.35rem 0.6rem;
	color: var(--ink);
	font-weight: 650;
}
.file-picker:hover .file-button {
	color: var(--accent);
}
.filename,
.actions span {
	min-width: 0;
	overflow-wrap: anywhere;
}
.actions,
.url {
	display: flex;
	align-items: center;
	flex-wrap: wrap;
	gap: 0 0.75rem;
}
.url {
	margin-top: 0.25rem;
}
.url input {
	flex: 1 1 11rem;
	width: 100%;
	min-width: 0;
	min-height: 44px;
}
button,
summary {
	min-height: 44px;
	width: fit-content;
	font: inherit;
	font-weight: 650;
	color: var(--accent);
	cursor: pointer;
}
button {
	border: 0;
	background: transparent;
	padding-inline: 0;
	text-decoration: underline;
	text-underline-offset: 0.16em;
}
summary {
	padding-block: 0.65rem;
}
.actions,
details,
p {
	color: var(--muted);
	font-size: 0.82rem;
}
p:empty {
	position: absolute;
}
.error {
	color: var(--composer-error);
}
</style>
