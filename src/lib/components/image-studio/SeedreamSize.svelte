<script lang="ts">
import type { SeedreamDraft, SeedreamOperation } from "#lib/shared/image-studio/seedream.ts";
import {
	poyoAspectRatios,
	type SeedreamProvider,
	seedreamResolutions,
} from "#lib/shared/image-studio/seedream-options.ts";
import { css } from "#styled-system/css";
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

const framingButton = {
	display: "grid",
	placeItems: "center",
	minWidth: "2.85rem",
	minHeight: "3.65rem",
	padding: "0.25rem 0.32rem 0.32rem",
	border: "1px solid {colors.border}",
	borderRadius: "8px",
	background: "surface",
	color: "muted",
	fontSize: "0.75rem",
	fontWeight: 650,
	fontVariantNumeric: "tabular-nums",
	lineHeight: 1.1,
	_hover: { borderColor: "accent", color: "accent" },
	_pressed: {
		borderColor: "accent",
		color: "accent",
		background: "color-mix(in srgb, {colors.accent} 8%, {colors.surface})",
		"@media (forced-colors: active)": { borderColor: "Highlight", textDecoration: "underline" },
	},
} as const;
const ratioButton = css(framingButton, { gridTemplateRows: "32px auto" });
const followReferencesButton = css(framingButton, {
	gridTemplateRows: "1fr",
	maxWidth: "5.7rem",
	paddingInline: "0.65rem",
});
const frame = css({
	width: "var(--frame-width)",
	height: "var(--frame-height)",
	border: "1px solid currentColor",
	borderRadius: "1px",
});

let {
	provider,
	operation,
	options = $bindable(),
	error,
}: {
	provider: SeedreamProvider;
	operation: SeedreamOperation;
	options: SeedreamDraft["options"];
	error?: string;
} = $props();

const id = $props.id();
const toapisPresets = [
	{ ratio: "1:1", width: 2048, height: 2048 },
	{ ratio: "4:3", width: 2304, height: 1728 },
	{ ratio: "3:4", width: 1728, height: 2304 },
	{ ratio: "16:9", width: 2560, height: 1440 },
	{ ratio: "9:16", width: 1440, height: 2560 },
] as const;

function frameDimensions(ratio: string) {
	const [width, height] = ratio.split(":").map(Number);
	const scale = 31 / Math.max(width, height);
	return { width: `${width * scale}px`, height: `${height * scale}px` };
}
</script>

<div class={css({ display: "grid", gap: "0.75rem" })}>
	<fieldset class={requestFieldset}>
		<legend class={requestLegend}>
			{provider === "poyo" ? "Aspect ratio" : "Framing presets"}
		</legend>
		<div class={css({ display: "flex", flexWrap: "wrap", gap: "0.375rem" })}>
			{#if provider === "poyo"}
				{#each poyoAspectRatios as ratio (ratio)}
					{@const dimensions = frameDimensions(ratio)}
					<button
						class={ratioButton}
						type="button"
						aria-pressed={options.aspectRatio === ratio}
						onclick={() => {
							options.aspectRatio = ratio;
						}}
					>
						<span
							class={frame}
							style:--frame-width={dimensions.width}
							style:--frame-height={dimensions.height}
							aria-hidden="true"
						></span>{ratio}
					</button>
				{/each}
				{#if operation === "edit"}
					<button
						class={followReferencesButton}
						type="button"
						aria-pressed={options.aspectRatio === "auto"}
						onclick={() => {
							options.aspectRatio = "auto";
						}}
					>
						Follow references
					</button>
				{/if}
			{:else}
				{#each toapisPresets as { ratio, width, height } (ratio)}
					{@const dimensions = frameDimensions(ratio)}
					<button
						class={ratioButton}
						type="button"
						aria-pressed={!error &&
							options.sizeMode === "pixels" &&
							!!options.width &&
							!!options.height &&
							options.width * height === options.height * width}
						onclick={() => {
							options = { ...options, sizeMode: "pixels", width, height };
						}}
					>
						<span
							class={frame}
							style:--frame-width={dimensions.width}
							style:--frame-height={dimensions.height}
							aria-hidden="true"
						></span>{ratio}
					</button>
				{/each}
			{/if}
		</div>
	</fieldset>

	<div class={requestFields}>
		{#if provider === "toapis"}
			<div class={requestField}>
				<label class={requestLabel} for={`${id}-size-mode`}>Size mode</label>
				<select class={requestControl} id={`${id}-size-mode`} bind:value={options.sizeMode}>
					<option value="tier">Resolution tier</option>
					<option value="pixels">Exact dimensions</option>
				</select>
			</div>
		{/if}
		{#if provider === "poyo" || options.sizeMode === "tier"}
			<div class={requestField}>
				<label class={requestLabel} for={`${id}-resolution`}>Resolution</label>
				<select class={requestControl} id={`${id}-resolution`} bind:value={options.resolution}>
					{#each seedreamResolutions as resolution (resolution)}
						<option value={resolution}>{resolution}</option>
					{/each}
				</select>
			</div>
		{/if}
	</div>
	{#if provider === "toapis"}
		{#if options.sizeMode === "pixels"}
			<div class={requestFields}>
				<label class={[requestField, requestLabel]}>
					Width (px)
					<input
						class={requestControl}
						type="number"
						min="1"
						step="1"
						bind:value={options.width}
						aria-invalid={!!error}
						aria-describedby={`${id}-dimensions`}
					>
				</label>
				<label class={[requestField, requestLabel]}>
					Height (px)
					<input
						class={requestControl}
						type="number"
						min="1"
						step="1"
						bind:value={options.height}
						aria-invalid={!!error}
						aria-describedby={`${id}-dimensions`}
					>
				</label>
			</div>
			<p class={error ? requestError : requestHelp} id={`${id}-dimensions`}>
				{error ?? "921,600–4,624,220 pixels total. Ratio from 1:16 to 16:1."}
			</p>
		{:else}
			<p class={requestHelp}>The provider chooses the ratio at this resolution.</p>
		{/if}
	{/if}
</div>
