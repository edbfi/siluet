<script lang="ts">
import { onMount, type Snippet, tick, untrack } from "svelte";
import {
	maxSeedreamReferences,
	referenceFileHelp,
	type SeedreamReference,
} from "#lib/shared/image-studio/references.ts";
import {
	createSeedreamDraft,
	poyoPromptLimits,
	type SeedreamDraft,
	type SeedreamOperation,
	type SeedreamProvider,
	type SeedreamReviewInput,
	seedreamBackgrounds,
	seedreamOperations,
	seedreamOutputFormats,
	seedreamProviderNames,
	seedreamProviders,
	switchSeedreamDraft,
	validateSeedreamDraft,
} from "#lib/shared/image-studio/seedream.ts";
import { css } from "#styled-system/css";
import { studioPanel } from "#styled-system/recipes";
import ImageReferencePreview from "./ImageReferencePreview.svelte";
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
} from "./request-styles.ts";
import SeedreamSize from "./SeedreamSize.svelte";

const alignFields = css({ alignItems: "start" });
const fieldHeading = css({
	display: "flex",
	flexWrap: "wrap",
	alignItems: "baseline",
	justifyContent: "space-between",
	gap: "0 0.5rem",
});
const requestLink = {
	color: "accent",
	fontSize: "0.85rem",
	fontWeight: 650,
	textDecoration: "underline",
	textUnderlineOffset: "0.16em",
} as const;
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
	settingsHref = "/settings/providers",
	reviewHref,
	reviewPanel,
	draft = $bindable(
		untrack(() =>
			createSeedreamDraft(
				seedreamProviders.find((provider) => eligibleProviders.includes(provider)) ?? null,
			),
		),
	),
	reviewInput = $bindable(null),
}: {
	eligibleProviders: readonly SeedreamProvider[];
	settingsHref?: string;
	reviewHref: string;
	reviewPanel: Snippet;
	draft?: SeedreamDraft;
	reviewInput?: SeedreamReviewInput | null;
} = $props();

const id = $props.id();
let connectedProviders = $derived(
	seedreamProviders.filter((provider) => eligibleProviders.includes(provider)),
);
const rememberedOptions = new Map<string, SeedreamDraft["options"]>();
let slotKeys = $state(
	untrack(() =>
		Array.from(
			{ length: Math.min(maxSeedreamReferences, draft.references.length + 1) },
			(_, index) => index,
		),
	),
);
let nextSlotKey = untrack(() => slotKeys.length);
let previewIndex = $state(0);
let selectionStatus = $state("");
let promptTouched = $state(untrack(() => draft.prompt.length > 0));
let promptField: HTMLTextAreaElement;
let preview: ReturnType<typeof ImageReferencePreview>;

const validation = $derived(validateSeedreamDraft(draft, connectedProviders));
const errors = $derived(validation.ok ? {} : validation.errors);

$effect(() => {
	const provider =
		connectedProviders.find((candidate) => candidate === draft.provider) ??
		connectedProviders[0] ??
		null;
	if (provider !== draft.provider) untrack(() => select(provider));
});

$effect(() => {
	reviewInput = validation.ok ? validation.input : null;
});

onMount(() => () => {
	reviewInput = null;
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
	slotKeys = [nextSlotKey++];
	draft = next;
}

function keepEmptySlot() {
	if (slotKeys.length === draft.references.length && slotKeys.length < maxSeedreamReferences) {
		slotKeys.push(nextSlotKey++);
	}
}

function setReference(index: number, reference: SeedreamReference) {
	draft.references[index] = reference;
	keepEmptySlot();
	previewIndex = index;
	selectionStatus = "";
}

async function removeReference(index: number) {
	draft.references.splice(index, 1);
	slotKeys.splice(index, 1);
	keepEmptySlot();
	if (previewIndex === index)
		previewIndex = Math.min(index, Math.max(0, draft.references.length - 1));
	else if (previewIndex > index) previewIndex--;

	const nextFile = `${id}-reference-${slotKeys[index]}`;
	await tick();
	document.getElementById(nextFile)?.focus({ preventScroll: true });
}

async function showReference(index: number) {
	previewIndex = index;
	await tick();
	preview.focus();
}

function useExample() {
	draft.prompt =
		draft.operation === "generate"
			? "An amber signal lamp on a rocky tidal shelf at blue hour. Dark coastal hills silhouette the horizon over rippling water."
			: "Warm the horizon to copper and keep the amber lamp in place. Let the warmer light reflect across the water.";
	promptField.focus();
}

function setBackground(background: SeedreamDraft["options"]["background"]) {
	draft.options.background = background;
	if (background === "transparent") draft.options.outputFormat = "png";
}
</script>

<div class={css({ containerType: "inline-size" })}>
	<header class={css({ marginBottom: "clamp(1.15rem, 2.8vw, 2rem)" })}>
		<h1>Image Studio</h1>
		<p class={css({ marginTop: "0.45rem", color: "muted" })}>
			Create a still or edit an image with references.
		</p>
	</header>

	<div
		class={css({
			display: "grid",
			gridTemplateColumns: "minmax(0, 0.94fr) minmax(0, 1.06fr)",
			alignItems: "start",
			gap: "clamp(1rem, 2.4vw, 1.9rem)",
			"@container (max-width: 41rem)": { gridTemplateColumns: "minmax(0, 1fr)" },
		})}
	>
		<section
			class={[
				studioPanel(),
				css({
					display: "grid",
					minWidth: 0,
					margin: 0,
					gap: "1rem",
					padding: "clamp(1rem, 2.25vw, 1.5rem)",
				}),
			]}
			aria-labelledby={`${id}-request`}
		>
			<div
				class={css({
					display: "flex",
					flexWrap: "wrap",
					justifyContent: "space-between",
					alignItems: "baseline",
					gap: "0.25rem 0.75rem",
				})}
			>
				<h2
					class={css({
						font: "680 1.18rem / 1.2 system-ui, sans-serif",
						letterSpacing: "-0.02em",
					})}
					id={`${id}-request`}
				>
					Request
				</h2>
				<a
					class={css(requestLink, {
						display: "none",
						"@container (max-width: 41rem)": {
							display: "inline-flex",
							minHeight: "44px",
							alignItems: "center",
						},
					})}
					href={reviewHref}
					>Review request</a
				>
			</div>

			<div class={[requestField, requestLabel]}>
				<div class={fieldHeading}>
					<label for={`${id}-model`}>Model</label>
					<span class={css({ color: "muted", fontWeight: 500 })} id={`${id}-family`}
						>ByteDance / Seedream</span
					>
				</div>
				<select class={requestControl} id={`${id}-model`} aria-describedby={`${id}-family`}>
					<optgroup label="ByteDance / Seedream">
						<option value="seedream-5.5">Seedream 5.5</option>
					</optgroup>
				</select>
			</div>

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
					{:else}
						<p class={requestHelp}>Connect a provider to prepare a request.</p>
						<a class={css(requestLink)} href={settingsHref}>Open Settings</a>
					{/if}
				</fieldset>

				<div class={[requestField, requestLabel]}>
					<label for={`${id}-operation`}>Operation</label>
					<select
						class={requestControl}
						id={`${id}-operation`}
						value={draft.operation}
						onchange={(event) =>
							select(draft.provider, event.currentTarget.value === "edit" ? "edit" : "generate")}
					>
						<option value="generate">{seedreamOperations.generate}</option>
						<option value="edit">{seedreamOperations.edit}</option>
					</select>
				</div>
			</div>

			{#if draft.provider && draft.operation === "edit"}
				{@const provider = draft.provider}
				{#key provider}
					<fieldset class={requestFieldset} aria-describedby={`${id}-reference-help`}>
						<legend class={requestLegend}>Reference images</legend>
						<p class={requestHelp} id={`${id}-reference-help`}>
							Add 1–{maxSeedreamReferences} images in prompt order.
							{referenceFileHelp(provider)} each.
						</p>
						{#each slotKeys as key, index (key)}
							<ImageReferenceSlot
								{provider}
								{index}
								fileId={`${id}-reference-${key}`}
								helpId={`${id}-reference-help`}
								reference={draft.references[index]}
								onSelect={(reference) => setReference(index, reference)}
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

			<div class={[requestField, requestLabel]}>
				<div class={fieldHeading}>
					<label for={`${id}-prompt`}>Prompt</label>
					<button
						class={css(requestLink, {
							minHeight: "44px",
							padding: 0,
							border: 0,
							background: "transparent",
						})}
						type="button"
						onclick={useExample}
					>
						Use example
					</button>
				</div>
				<textarea
					class={css({
						width: "100%",
						minWidth: 0,
						font: "inherit",
						fontWeight: 400,
						resize: "vertical",
						minHeight: "7rem",
						padding: "0.65rem 0.8rem",
						border: "1px solid {colors.border}",
						borderRadius: "7px",
						background: "surface",
						color: "ink",
						caretColor: "accent",
						_placeholder: { color: "muted" },
					})}
					bind:this={promptField}
					bind:value={draft.prompt}
					id={`${id}-prompt`}
					rows="4"
					required
					aria-invalid={promptTouched && !!errors.prompt}
					aria-describedby={draft.provider === "poyo" || (promptTouched && errors.prompt)
						? `${id}-prompt-help`
						: undefined}
					onblur={() => {
						promptTouched = true;
					}}
					placeholder={draft.operation === "edit"
						? "Describe what should change and what should stay the same."
						: "Describe the subject, setting, and light."}
				></textarea>
				{#if promptTouched && errors.prompt}
					<p class={requestError} id={`${id}-prompt-help`}>{errors.prompt}</p>
				{:else if draft.provider === "poyo"}
					<p class={requestHelp} id={`${id}-prompt-help`}>
						{poyoPromptLimits.min}–{poyoPromptLimits.max.toLocaleString("en-US")} characters
					</p>
				{/if}
			</div>

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
							<select
								class={requestControl}
								id={`${id}-format`}
								bind:value={draft.options.outputFormat}
							>
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
							ToAPIs may use a fallback when your account and region are eligible. Fallback is
							unavailable in mainland China and China sales regions.
						</p>
					{/if}
				</details>
			{/if}
		</section>
		<div class={css({ display: "grid", minWidth: 0, gap: "1rem" })}>
			<ImageReferencePreview
				bind:this={preview}
				operation={draft.operation}
				index={previewIndex}
				reference={draft.references[previewIndex]}
			/>
			{@render reviewPanel()}
		</div>
	</div>
</div>
