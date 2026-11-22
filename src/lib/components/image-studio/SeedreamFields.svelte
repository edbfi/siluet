<script lang="ts">
import { tick, untrack } from "svelte";
import {
	maxSeedreamReferences,
	referenceFileHelp,
	type SeedreamReference,
} from "#lib/shared/image-studio/references.ts";
import {
	poyoPromptLimits,
	type SeedreamDraft,
	type SeedreamOperation,
	type SeedreamProvider,
	seedreamBackgrounds,
	seedreamOutputFormats,
	seedreamProviderNames,
	switchSeedreamDraft,
	type validateSeedreamDraft,
} from "#lib/shared/image-studio/seedream.ts";
import {
	releasedImageOperations,
	releasedProviders,
	seedreamModel,
} from "#lib/shared/media-catalog/registry.ts";
import { css } from "#styled-system/css";
import { createReferenceDraft, type ReferenceDraft, referenceLabel } from "./draft-context.ts";
import ImagePrompt from "./ImagePrompt.svelte";
import ImageReferenceGuidance from "./ImageReferenceGuidance.svelte";
import ImageReferenceSlot from "./ImageReferenceSlot.svelte";
import {
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
import SeedreamSize from "./SeedreamSize.svelte";

const alignFields = css({ alignItems: "start" });
const providerOption = css({
	position: "relative",
	display: "grid",
	flex: 1,
	placeItems: "center",
	minHeight: "38px",
	paddingInline: "0.25rem",
	border: "1px solid transparent",
	borderRadius: "6px",
	color: "muted",
	fontSize: "0.85rem",
	cursor: "pointer",
	_hover: { color: "accent" },
	"&:has(:checked)": {
		borderColor: "accent",
		background: "surface",
		color: "accent",
		fontWeight: 650,
		"@media (forced-colors: active)": { borderColor: "Highlight" },
	},
	"&:has(:focus-visible)": {
		outline: "3px solid {colors.accent}",
		outlineOffset: "2px",
	},
});
const providerRadio = css({
	position: "absolute",
	inset: 0,
	width: "100%",
	height: "100%",
	margin: 0,
	opacity: 0,
	cursor: "pointer",
});

let {
	eligibleProviders,
	unavailableProviders,
	settingsHref = "/settings/providers",
	previewIndex = $bindable(),
	focusPreview,
	duplicateWarning,
	referenceDraft = $bindable(),
	draft = $bindable(),
	validation,
}: {
	eligibleProviders: readonly SeedreamProvider[];
	unavailableProviders: readonly string[];
	settingsHref?: string;
	previewIndex: number;
	focusPreview: () => void;
	duplicateWarning: string | null;
	referenceDraft: ReferenceDraft;
	draft: SeedreamDraft;
	validation: ReturnType<typeof validateSeedreamDraft>;
} = $props();

const id = $props.id();
let connectedProviders = $derived(
	releasedProviders.filter((provider) => eligibleProviders.includes(provider)),
);
const operations = $derived(
	releasedImageOperations.filter(
		(entry) =>
			entry.modelId === seedreamModel.id &&
			entry.key.provider === (draft.provider ?? releasedProviders[0]),
	),
);
const rememberedOptions = new Map<string, SeedreamDraft["options"]>();

let selectionStatus = $state("");

const errors = $derived(validation.ok ? {} : validation.errors);

$effect(() => {
	const provider =
		connectedProviders.find((candidate) => candidate === draft.provider) ??
		connectedProviders[0] ??
		null;
	if (provider !== draft.provider) untrack(() => select(provider));
});

function select(provider: SeedreamProvider | null, operation: SeedreamOperation = draft.operation) {
	const next = switchSeedreamDraft(draft, provider, operation);
	if (next === draft) return;
	if (draft.provider) {
		rememberedOptions.set(`${draft.provider}/${draft.operation}`, { ...draft.options });
	}
	const previousOptions = rememberedOptions.get(`${provider}/${operation}`);
	if (previousOptions) next.options = { ...previousOptions };
	selectionStatus = "";
	if (draft.references.length) {
		selectionStatus =
			provider && operation === "edit"
				? "Reference images cleared. Choose them again for this request."
				: "Reference images cleared.";
	}
	previewIndex = 0;
	referenceDraft = createReferenceDraft();
	draft = next;
}

function reserveIdentity() {
	return referenceDraft.nextIdentity++;
}

function keepEmptySlot() {
	const slots = referenceDraft.slots;
	if (slots.length === draft.references.length && slots.length < maxSeedreamReferences) {
		const identity = reserveIdentity();
		slots.push({ key: identity, identity, privateName: "" });
	}
}

function setReference(
	index: number,
	reference: SeedreamReference,
	privateName = "",
	replacementIdentity?: number,
) {
	const slot = referenceDraft.slots[index];
	if (draft.references[index]) slot.identity = replacementIdentity ?? reserveIdentity();
	slot.privateName = privateName;
	draft.references[index] = reference;
	keepEmptySlot();
	previewIndex = index;
	selectionStatus = "";
}

async function removeReference(index: number) {
	draft.references.splice(index, 1);
	referenceDraft.slots.splice(index, 1);
	keepEmptySlot();
	selectionStatus = "";
	if (previewIndex === index)
		previewIndex = Math.min(index, Math.max(0, draft.references.length - 1));
	else if (previewIndex > index) previewIndex--;

	const nextSlot = referenceDraft.slots[index];
	await tick();
	document.getElementById(`${id}-reference-${nextSlot.key}`)?.focus({ preventScroll: true });
}

async function moveReference(index: number, offset: -1 | 1) {
	const destination = index + offset;
	const reference = draft.references[index];
	if (!reference || !draft.references[destination]) return;
	const slot = referenceDraft.slots[index];
	draft.references.splice(index, 1);
	draft.references.splice(destination, 0, reference);
	referenceDraft.slots.splice(index, 1);
	referenceDraft.slots.splice(destination, 0, slot);
	if (previewIndex === index) previewIndex = destination;
	else if (previewIndex === destination) previewIndex = index;
	selectionStatus = `Reference ${referenceLabel(slot.identity)} moved to position ${destination + 1} of ${draft.references.length}.`;
	await tick();
	const fileId = `${id}-reference-${slot.key}`;
	const up = document.getElementById(`${fileId}-up`) as HTMLButtonElement | null;
	const down = document.getElementById(`${fileId}-down`) as HTMLButtonElement | null;
	const [preferred, alternate] = offset === -1 ? [up, down] : [down, up];
	const focus =
		preferred && !preferred.disabled ? preferred : (alternate ?? document.getElementById(fileId));
	focus?.focus();
}

async function showReference(index: number) {
	previewIndex = index;
	await tick();
	focusPreview();
}

function setBackground(background: SeedreamDraft["options"]["background"]) {
	draft.options.background = background;
	if (background === "transparent") draft.options.outputFormat = "png";
}
</script>
<div class={[requestFields, alignFields]}>
	<fieldset class={requestFieldset}>
		<legend class={requestLegend}>API provider</legend>
		{#if connectedProviders.length}
			<div
				class={css({
					display: "flex",
					gap: "0.15rem",
					padding: "2px",
					border: "1px solid {colors.border}",
					borderRadius: "8px",
					background: "canvas",
				})}
			>
				{#each connectedProviders as provider (provider)}
					<label class={providerOption}>
						<input
							class={providerRadio}
							type="radio"
							name={`${id}-provider`}
							value={provider}
							checked={draft.provider === provider}
							onchange={() => select(provider)}
						>
						{seedreamProviderNames[provider]}
					</label>
				{/each}
			</div>
		{/if}
		{#each unavailableProviders as reason (reason)}
			<p class={requestHelp}>{reason}</p>
		{/each}
		{#if !connectedProviders.length}
			<a class={css(requestLink)} href={settingsHref}>Open Settings</a>
		{/if}
	</fieldset>

	<div class={[requestField, requestLabel]}>
		<label for={`${id}-operation`}>Operation</label>
		<select
			class={requestControl}
			id={`${id}-operation`}
			value={draft.operation}
			onchange={(event) => {
				const value = event.currentTarget.value;
				const entry = operations.find(({ mode }) => mode === value);
				if (entry) select(draft.provider, entry.mode);
			}}
		>
			{#each operations as entry (entry.key.operation)}
				<option value={entry.mode}>{entry.label}</option>
			{/each}
		</select>
	</div>
</div>

{#if draft.operation === "edit"}
	{@const provider = draft.provider}
	{#key provider}
		<fieldset class={requestFieldset} aria-describedby={`${id}-reference-help`}>
			<legend class={requestLegend}>Reference images</legend>
			<p class={requestHelp} id={`${id}-reference-help`}>
				{#if provider}
					Queue supports 1–{maxSeedreamReferences} public image URLs. For offline Review, you can
					also stage files ({referenceFileHelp(provider)} each).
				{:else}
					Queue needs a connected provider. For offline Review, you can prepare a local
					{referenceFileHelp(provider)} copy now.
				{/if}
			</p>
			{#if provider}
				<ImageReferenceGuidance
					{provider}
					autoFraming={draft.references.length > 1 && draft.options.aspectRatio === "auto"}
				/>
			{/if}
			{#if duplicateWarning}
				<p class={requestError} role="status">{duplicateWarning}</p>
			{/if}
			{#each referenceDraft.slots as slot, index (slot.key)}
				<ImageReferenceSlot
					{provider}
					{index}
					{slot}
					fileId={`${id}-reference-${slot.key}`}
					helpId={`${id}-reference-help`}
					reference={draft.references[index]}
					canMoveDown={index < draft.references.length - 1}
					{reserveIdentity}
					onSelect={(reference, privateName, replacementIdentity) =>
						setReference(index, reference, privateName, replacementIdentity)}
					onRename={(name) => (slot.privateName = name)}
					onMove={(offset) => moveReference(index, offset)}
					onRemove={() => removeReference(index)}
					onPreview={() => showReference(index)}
				/>
			{/each}
		</fieldset>
	{/key}
{/if}
<p class={[requestHelp, css({ _empty: { position: "absolute" } })]} role="status">
	{selectionStatus}
</p>

<ImagePrompt
	bind:prompt={draft.prompt}
	operation={draft.operation}
	error={errors.prompt}
	hint={draft.provider === "poyo"
		? `${poyoPromptLimits.min}–${poyoPromptLimits.max.toLocaleString("en-US")} characters`
		: undefined}
/>

{#if draft.provider}
	<SeedreamSize
		provider={draft.provider}
		operation={draft.operation}
		bind:options={draft.options}
		error={errors.size}
	/>

	<details class={css({ minWidth: 0, borderTop: "1px solid {colors.line}" })}>
		<summary
			class={[
				requestLabel,
				css({
					width: "fit-content",
					minHeight: "44px",
					padding: "0.75rem 0",
					cursor: "pointer",
					"&::marker": { color: "accent" },
				}),
			]}
		>
			Advanced options
		</summary>
		<div class={[requestFields, alignFields]}>
			<div class={[requestField, requestLabel]}>
				<label for={`${id}-background`}>Background</label>
				<select
					class={requestControl}
					id={`${id}-background`}
					bind:value={() => draft.options.background, setBackground}
				>
					{#each seedreamBackgrounds as background (background)}
						<option value={background}>
							{background[0].toUpperCase() + background.slice(1)}
						</option>
					{/each}
				</select>
			</div>
			<div class={[requestField, requestLabel]}>
				<label for={`${id}-format`}>Output format</label>
				<select class={requestControl} id={`${id}-format`} bind:value={draft.options.outputFormat}>
					{#each seedreamOutputFormats as format (format)}
						<option
							value={format}
							disabled={format === "jpeg" && draft.options.background === "transparent"}
						>
							{format.toUpperCase()}
						</option>
					{/each}
				</select>
			</div>
		</div>
		{#if draft.options.background === "transparent"}
			<p class={[requestHelp, css({ marginTop: "0.375rem" })]}>Transparency requires PNG.</p>
		{/if}
		{#if draft.provider === "toapis"}
			<label
				class={[
					requestLabel,
					css({ display: "flex", alignItems: "center", gap: "0.5rem", minHeight: "44px" }),
				]}
				><input
					class={css({ accentColor: "accent" })}
					type="checkbox"
					bind:checked={draft.options.watermark}
				>
				Visible watermark</label
			>
			<p class={requestHelp}>
				ToAPIs may use a fallback when your account and region are eligible. Fallback is unavailable
				in mainland China and China sales regions.
			</p>
		{/if}
	</details>
{/if}
