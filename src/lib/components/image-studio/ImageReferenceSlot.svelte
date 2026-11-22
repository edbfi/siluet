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
import { css } from "#styled-system/css";
import { type ReferenceSlotDraft, referenceLabel } from "./draft-context.ts";
import { referenceAction, requestControl, requestField, requestLabel } from "./request-styles.ts";

const slot = css({ display: "grid", gap: "0.3rem", minWidth: 0, paddingBlock: "0.75rem" });
const fileName = css({ minWidth: 0, overflowWrap: "anywhere" });
const actionRow = css({
	display: "flex",
	alignItems: "center",
	flexWrap: "wrap",
	gap: "0 0.75rem",
});
const referenceDetail = css({ color: "muted", fontSize: "0.82rem" });

let {
	provider,
	index,
	slot: slotDraft,
	reference,
	fileId,
	helpId,
	canMoveDown,
	reserveIdentity,
	onSelect,
	onRename,
	onMove,
	onRemove,
	onPreview,
}: {
	provider: SeedreamProvider;
	index: number;
	slot: ReferenceSlotDraft;
	reference: SeedreamReference | undefined;
	fileId: string;
	helpId: string;
	canMoveDown: boolean;
	reserveIdentity: () => number;
	onSelect: (
		reference: SeedreamReference,
		privateName?: string,
		replacementIdentity?: number,
	) => void;
	onRename: (name: string) => void;
	onMove: (offset: -1 | 1) => void;
	onRemove: () => void;
	onPreview: () => void;
} = $props();

const id = $props.id();
let fileInput: HTMLInputElement;
let urlField: HTMLInputElement;
let urlDisclosure: HTMLDetailsElement;
let url = $state("");
let candidateName = $state("");
let replacementIdentity = $state<number>();
let error = $state("");
let pending = $state(false);
let selection = 0;
const label = $derived(`Reference image ${index + 1}`);
const identity = $derived(referenceLabel(slotDraft.identity));
const candidateLabel = $derived(referenceLabel(replacementIdentity ?? slotDraft.identity));

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
	let result = await checkReferenceFile(provider, file);
	if (selection !== currentSelection) return;
	if (!result) {
		try {
			const bitmap = await createImageBitmap(file);
			bitmap.close();
		} catch {
			result = "Could not decode this image. Choose a complete image file.";
		}
	}
	if (selection !== currentSelection) return;
	pending = false;
	if (result) {
		error = result;
		return;
	}
	onSelect({ kind: "file", file });
	clearUrlFields();
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
	onSelect(reference, candidateName, replacementIdentity);
	clearUrlFields();
	await tick();
	fileInput?.focus({ preventScroll: true });
}

function clearUrlFields() {
	url = "";
	candidateName = "";
	replacementIdentity = undefined;
	urlDisclosure.open = false;
}
</script>

{#snippet nameField(identity: string, value: string, onInput: (name: string) => void)}
	<label class={[requestField, requestLabel]}>
		Private name (optional)
		<input
			class={requestControl}
			type="text"
			aria-label={`Private name for reference ${identity}`}
			{value}
			oninput={(event) => onInput(event.currentTarget.value)}
			autocomplete="off"
			spellcheck="false"
		>
	</label>
{/snippet}

<div class={[slot, index > 0 && css({ borderTop: "1px solid {colors.line}" })]}>
	<label class={requestLabel} for={fileId}>{label}</label>
	<div
		class={[
			"group",
			css({
				position: "relative",
				display: "flex",
				alignItems: "center",
				minHeight: "44px",
				gap: "0.65rem",
				padding: "0.25rem",
				border: "1px dashed {colors.border}",
				borderRadius: "8px",
				fontSize: "0.85rem",
				"&:has(:focus-visible)": {
					outline: "3px solid {colors.accent}",
					outlineOffset: "3px",
				},
			}),
		]}
	>
		<span
			class={css({
				flex: "none",
				borderRadius: "5px",
				background: "canvas",
				padding: "0.35rem 0.6rem",
				color: "ink",
				fontWeight: 650,
				_groupHover: { color: "accent" },
			})}
			aria-hidden="true"
		>
			{reference?.kind === "file" ? "Replace file" : "Choose file"}
		</span>
		{#if reference?.kind === "file"}
			<span class={fileName} id={`${id}-name`}>{reference.file.name}</span>
		{/if}
		<input
			class={css({
				position: "absolute",
				inset: 0,
				width: "100%",
				height: "100%",
				opacity: 0,
				cursor: "pointer",
			})}
			bind:this={fileInput}
			id={fileId}
			type="file"
			accept={referenceFileAccept(provider)}
			aria-describedby={`${helpId} ${id}-status${reference?.kind === "file" ? ` ${id}-name` : ""}`}
			onchange={chooseFile}
		>
	</div>
	{#if reference}
		{#if reference.kind === "url"}
			<p class={[fileName, referenceDetail]}>
				<strong class={css({ color: "ink" })}>Reference {identity}</strong> ·
				<span>{reference.hostname} (URL hidden)</span>
			</p>
			{@render nameField(identity, slotDraft.privateName, onRename)}
		{/if}
		<div class={[actionRow, referenceDetail]}>
			{#if reference.kind === "file"}
				<button
					class={referenceAction}
					type="button"
					onclick={onPreview}
					aria-label={`Preview ${label.toLowerCase()}`}
				>
					Preview
				</button>
			{/if}
			<button
				class={referenceAction}
				type="button"
				id={`${fileId}-up`}
				disabled={index === 0}
				onclick={() => onMove(-1)}
				aria-label={`Move up ${label.toLowerCase()}`}
			>
				Move up
			</button>
			<button
				class={referenceAction}
				type="button"
				id={`${fileId}-down`}
				disabled={!canMoveDown}
				onclick={() => onMove(1)}
				aria-label={`Move down ${label.toLowerCase()}`}
			>
				Move down
			</button>
			<button
				class={referenceAction}
				type="button"
				onclick={onRemove}
				aria-label={`Remove ${label.toLowerCase()}`}
			>
				Remove
			</button>
		</div>
	{/if}

	<details
		class={referenceDetail}
		bind:this={urlDisclosure}
		ontoggle={(event) => {
			if (reference && event.currentTarget.open) replacementIdentity ??= reserveIdentity();
		}}
	>
		<summary
			class={css({
				minHeight: "44px",
				width: "fit-content",
				font: "inherit",
				fontWeight: 650,
				color: "accent",
				cursor: "pointer",
				paddingBlock: "0.65rem",
			})}
		>
			Use a URL
		</summary>
		<form
			class={requestField}
			onsubmit={(event) => {
				event.preventDefault();
				void chooseUrl();
			}}
		>
			<p class={requestLabel}>Reference {candidateLabel}</p>
			<label class={requestLabel} for={`${id}-url`}
				>HTTP or HTTPS URL for {label.toLowerCase()}</label
			>
			<input
				class={requestControl}
				bind:this={urlField}
				bind:value={url}
				id={`${id}-url`}
				type="text"
				inputmode="url"
				autocomplete="off"
				autocapitalize="none"
				spellcheck="false"
				aria-describedby={`${id}-status`}
			>
			{@render nameField(candidateLabel, candidateName, (name) => (candidateName = name))}
			<button class={referenceAction} type="submit">Use URL</button>
		</form>
	</details>

	<p
		class={[
			css({ fontSize: "0.82rem", _empty: { position: "absolute" } }),
			error ? css({ color: "danger" }) : css({ color: "muted" }),
		]}
		role="status"
		id={`${id}-status`}
	>
		{error || (pending ? "Checking file…" : "")}
	</p>
</div>
