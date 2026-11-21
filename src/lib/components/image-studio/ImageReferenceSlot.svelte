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
import { requestLabel } from "./request-styles.ts";

const slot = css({ display: "grid", gap: "0.3rem", minWidth: 0, paddingBlock: "0.75rem" });
const fileName = css({ minWidth: 0, overflowWrap: "anywhere" });
const actionRow = css({
	display: "flex",
	alignItems: "center",
	flexWrap: "wrap",
	gap: "0 0.75rem",
});
const referenceDetail = css({ color: "muted", fontSize: "0.82rem" });
const referenceAction = css({
	minHeight: "44px",
	width: "fit-content",
	font: "inherit",
	fontWeight: 650,
	color: "accent",
	cursor: "pointer",
	border: 0,
	background: "transparent",
	paddingInline: 0,
	textDecoration: "underline",
	textUnderlineOffset: "0.16em",
});

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
		<div class={[actionRow, referenceDetail]}>
			{#if reference.kind === "url"}
				<span class={fileName}>{reference.hostname} (URL hidden)</span>
			{:else}
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
				onclick={onRemove}
				aria-label={`Remove ${label.toLowerCase()}`}
			>
				Remove
			</button>
		</div>
	{/if}

	<details class={referenceDetail} bind:this={urlDisclosure}>
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
		<label class={requestLabel} for={`${id}-url`}
			>HTTP or HTTPS URL for {label.toLowerCase()}</label
		>
		<div class={[actionRow, css({ marginTop: "0.25rem" })]}>
			<input
				class={css({ flex: "1 1 11rem", width: "100%", minWidth: 0, minHeight: "44px" })}
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
			<button class={referenceAction} type="button" onclick={chooseUrl}>Use URL</button>
		</div>
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
