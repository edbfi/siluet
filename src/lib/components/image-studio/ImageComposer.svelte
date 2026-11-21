<script lang="ts">
import { onMount, tick, untrack } from "svelte";
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
import ImageReferencePreview from "./ImageReferencePreview.svelte";
import ImageReferenceSlot from "./ImageReferenceSlot.svelte";
import SeedreamSize from "./SeedreamSize.svelte";

let {
	eligibleProviders,
	settingsHref = "/settings/providers",
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
			operation === "edit"
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

<div class="composer">
	<header>
		<h1>Image Studio</h1>
		<p>Create a still or edit an image with references.</p>
	</header>

	<div class="layout">
		<section class="request" aria-labelledby={`${id}-request`}>
			<h2 id={`${id}-request`}>Request</h2>

			<div class="field">
				<div class="model-label">
					<label for={`${id}-model`}>Model</label>
					<span id={`${id}-family`}>ByteDance / Seedream</span>
				</div>
				<select id={`${id}-model`} aria-describedby={`${id}-family`}>
					<optgroup label="ByteDance / Seedream">
						<option value="seedream-5.5">Seedream 5.5</option>
					</optgroup>
				</select>
			</div>

			<div class="fields">
				<fieldset>
					<legend>API provider</legend>
					{#if connectedProviders.length}
						<div class="providers">
							{#each connectedProviders as provider (provider)}
								<label class="provider">
									<input
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
						<p class="help">Connect a provider to prepare a request.</p>
						<a href={settingsHref}>Open Settings</a>
					{/if}
				</fieldset>

				<div class="field">
					<label for={`${id}-operation`}>Operation</label>
					<select
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
					<fieldset class="references" aria-describedby={`${id}-reference-help`}>
						<legend>Reference images</legend>
						<p class="help" id={`${id}-reference-help`}>
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
			<p class="help selection-status" role="status">{selectionStatus}</p>

			<div class="field">
				<div class="prompt-label">
					<label for={`${id}-prompt`}>Prompt</label>
					<button class="text-button" type="button" onclick={useExample}>Use example</button>
				</div>
				<textarea
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
					<p class="help error" id={`${id}-prompt-help`}>{errors.prompt}</p>
				{:else if draft.provider === "poyo"}
					<p class="help" id={`${id}-prompt-help`}>
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

				<details class="advanced">
					<summary>Advanced options</summary>
					<div class="fields">
						<div class="field">
							<label for={`${id}-background`}>Background</label>
							<select
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
						<div class="field">
							<label for={`${id}-format`}>Output format</label>
							<select id={`${id}-format`} bind:value={draft.options.outputFormat}>
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
						<p class="help transparency-help">Transparency requires PNG.</p>
					{/if}
					{#if draft.provider === "toapis"}
						<label class="watermark"
							><input type="checkbox" bind:checked={draft.options.watermark}> Visible
							watermark</label
						>
						<p class="help">
							ToAPIs may use a fallback when your account and region are eligible. Fallback is
							unavailable in mainland China and China sales regions.
						</p>
					{/if}
				</details>
			{/if}
		</section>
		<ImageReferencePreview
			bind:this={preview}
			operation={draft.operation}
			index={previewIndex}
			reference={draft.references[previewIndex]}
		/>
	</div>
</div>

<style>
.composer {
	--composer-error: light-dark(#992c28, #ffb7ae);
	--composer-selection: color-mix(in srgb, var(--accent) 8%, var(--surface));
	container-type: inline-size;
}
header {
	margin-bottom: clamp(1.15rem, 2.8vw, 2rem);
}
header p {
	margin-top: 0.45rem;
	color: var(--muted);
}
.layout {
	display: grid;
	grid-template-columns: minmax(0, 0.94fr) minmax(0, 1.06fr);
	align-items: start;
	gap: clamp(1rem, 2.4vw, 1.9rem);
}
.request {
	display: grid;
	min-width: 0;
	margin: 0;
	gap: 1rem;
	padding: clamp(1rem, 2.25vw, 1.5rem);
	border: 1px solid var(--line);
	border-radius: 15px;
	background: var(--surface);
}
h2 {
	font:
		680 1.18rem / 1.2 system-ui,
		sans-serif;
	letter-spacing: -0.02em;
}
.fields {
	display: grid;
	grid-template-columns: repeat(auto-fit, minmax(min(8rem, 100%), 1fr));
	gap: 0.75rem;
	align-items: start;
}
.field {
	display: grid;
	gap: 0.35rem;
	min-width: 0;
	font-size: 0.85rem;
	font-weight: 650;
}
.model-label,
.prompt-label {
	display: flex;
	flex-wrap: wrap;
	align-items: baseline;
	justify-content: space-between;
	gap: 0 0.5rem;
}
.model-label span {
	color: var(--muted);
	font-weight: 500;
}
fieldset {
	min-width: 0;
	margin: 0;
	padding: 0;
	border: 0;
}
legend,
summary {
	padding: 0;
	font-size: 0.85rem;
	font-weight: 650;
}
legend {
	margin-bottom: 0.35rem;
}
.providers {
	display: flex;
	gap: 0.15rem;
	padding: 2px;
	border: 1px solid var(--border);
	border-radius: 8px;
	background: var(--canvas);
}
.provider {
	position: relative;
	display: grid;
	flex: 1;
	place-items: center;
	min-height: 38px;
	padding-inline: 0.25rem;
	border: 1px solid transparent;
	border-radius: 6px;
	color: var(--muted);
	font-size: 0.85rem;
	cursor: pointer;
}
.provider:has(:checked) {
	border-color: var(--accent);
	background: var(--surface);
	color: var(--accent);
	font-weight: 650;
}
.provider:has(:focus-visible) {
	outline: 3px solid var(--accent);
	outline-offset: 2px;
}
.provider input {
	position: absolute;
	inset: 0;
	width: 100%;
	height: 100%;
	margin: 0;
	opacity: 0;
	cursor: pointer;
}
.provider:hover {
	color: var(--accent);
}
select,
textarea {
	width: 100%;
	min-width: 0;
	min-height: 44px;
	font: inherit;
	font-weight: 400;
}
textarea {
	resize: vertical;
	min-height: 7rem;
	padding: 0.65rem 0.8rem;
	border: 1px solid var(--border);
	border-radius: 7px;
	background: var(--surface);
	color: var(--ink);
	caret-color: var(--accent);
}
textarea::placeholder {
	color: var(--muted);
}
a,
.text-button {
	color: var(--accent);
	font-size: 0.85rem;
	font-weight: 650;
	text-decoration: underline;
	text-underline-offset: 0.16em;
}
.text-button {
	min-height: 44px;
	padding: 0;
	border: 0;
	background: transparent;
}
.help {
	color: var(--muted);
	font-size: 0.8rem;
	font-weight: 400;
}
.error {
	color: var(--composer-error);
}
.selection-status:empty {
	position: absolute;
}
.advanced {
	min-width: 0;
	border-top: 1px solid var(--line);
}
.advanced summary {
	width: fit-content;
	min-height: 44px;
	padding-block: 0.75rem;
	cursor: pointer;
}
.advanced summary::marker {
	color: var(--accent);
}
.transparency-help {
	margin-top: 0.375rem;
}
.watermark {
	display: flex;
	align-items: center;
	gap: 0.5rem;
	min-height: 44px;
	font-size: 0.85rem;
	font-weight: 650;
}
.watermark input {
	accent-color: var(--accent);
}
@container (max-width: 41rem) {
	.layout {
		grid-template-columns: minmax(0, 1fr);
	}
}
@media (forced-colors: active) {
	.provider:has(:checked) {
		border-color: Highlight;
	}
}
</style>
