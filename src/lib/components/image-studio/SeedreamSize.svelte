<script lang="ts">
import {
	poyoAspectRatios,
	type SeedreamDraft,
	type SeedreamOperation,
	type SeedreamProvider,
	seedreamResolutions,
} from "#lib/shared/image-studio/seedream.ts";

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

function frame(ratio: string) {
	const [width, height] = ratio.split(":").map(Number);
	const scale = 31 / Math.max(width, height);
	return `width: ${width * scale}px; height: ${height * scale}px;`;
}
</script>

<div class="size">
	<fieldset>
		<legend>{provider === "poyo" ? "Aspect ratio" : "Framing presets"}</legend>
		<div class="ratios">
			{#if provider === "poyo"}
				{#each poyoAspectRatios as ratio (ratio)}
					<button
						type="button"
						aria-pressed={options.aspectRatio === ratio}
						onclick={() => {
							options.aspectRatio = ratio;
						}}
					>
						<span class="frame" style={frame(ratio)} aria-hidden="true"></span>{ratio}
					</button>
				{/each}
				{#if operation === "edit"}
					<button
						class="automatic"
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
					<button
						type="button"
						aria-pressed={options.sizeMode === "pixels" &&
							!!options.width &&
							!!options.height &&
							options.width * height === options.height * width}
						onclick={() => {
							options = { ...options, sizeMode: "pixels", width, height };
						}}
					>
						<span class="frame" style={frame(ratio)} aria-hidden="true"></span>{ratio}
					</button>
				{/each}
			{/if}
		</div>
	</fieldset>

	<div class="fields">
		{#if provider === "toapis"}
			<div class="field">
				<label for={`${id}-size-mode`}>Size mode</label>
				<select id={`${id}-size-mode`} bind:value={options.sizeMode}>
					<option value="tier">Resolution tier</option>
					<option value="pixels">Exact dimensions</option>
				</select>
			</div>
		{/if}
		{#if provider === "poyo" || options.sizeMode === "tier"}
			<div class="field">
				<label for={`${id}-resolution`}>Resolution</label>
				<select id={`${id}-resolution`} bind:value={options.resolution}>
					{#each seedreamResolutions as resolution (resolution)}
						<option value={resolution}>{resolution}</option>
					{/each}
				</select>
			</div>
		{/if}
	</div>
	{#if provider === "toapis"}
		{#if options.sizeMode === "pixels"}
			<div class="fields">
				<label class="field">
					Width (px)
					<input
						type="number"
						min="1"
						step="1"
						bind:value={options.width}
						aria-invalid={!!error}
						aria-describedby={`${id}-dimensions`}
					>
				</label>
				<label class="field">
					Height (px)
					<input
						type="number"
						min="1"
						step="1"
						bind:value={options.height}
						aria-invalid={!!error}
						aria-describedby={`${id}-dimensions`}
					>
				</label>
			</div>
			<p class:error id={`${id}-dimensions`}>
				{error ?? "921,600–4,624,220 pixels total. Ratio from 1:16 to 16:1."}
			</p>
		{:else}
			<p>The provider chooses the ratio at this resolution.</p>
		{/if}
	{/if}
</div>

<style>
.size {
	display: grid;
	gap: 0.75rem;
}
fieldset {
	min-width: 0;
	margin: 0;
	padding: 0;
	border: 0;
}
legend,
label {
	font-size: 0.85rem;
	font-weight: 650;
}
legend {
	padding: 0;
	margin-bottom: 0.35rem;
}
.ratios {
	display: flex;
	flex-wrap: wrap;
	gap: 0.375rem;
}
button {
	display: grid;
	grid-template-rows: 32px auto;
	place-items: center;
	min-width: 2.85rem;
	min-height: 3.65rem;
	padding: 0.25rem 0.32rem 0.32rem;
	border: 1px solid var(--border);
	border-radius: 8px;
	background: var(--surface);
	color: var(--muted);
	font-size: 0.75rem;
	font-weight: 650;
	font-variant-numeric: tabular-nums;
	line-height: 1.1;
}
button.automatic {
	grid-template-rows: 1fr;
	max-width: 5.7rem;
	padding-inline: 0.65rem;
}
button:hover,
button[aria-pressed="true"] {
	border-color: var(--accent);
	color: var(--accent);
}
button[aria-pressed="true"] {
	background: var(--composer-selection);
}
.frame {
	border: 1px solid currentColor;
	border-radius: 1px;
}
.fields {
	display: grid;
	grid-template-columns: repeat(auto-fit, minmax(min(8rem, 100%), 1fr));
	gap: 0.75rem;
}
.field {
	display: grid;
	min-width: 0;
	gap: 0.35rem;
}
select,
input {
	width: 100%;
	min-width: 0;
	min-height: 44px;
	font-weight: 400;
}
p {
	color: var(--muted);
	font-size: 0.8rem;
}
.error {
	color: var(--composer-error);
}
@media (forced-colors: active) {
	button[aria-pressed="true"] {
		border-color: Highlight;
		text-decoration: underline;
	}
}
</style>
