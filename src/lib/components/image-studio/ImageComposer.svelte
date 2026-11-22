<script lang="ts">
import type { Snippet } from "svelte";
import type { SeedreamReference } from "#lib/shared/image-studio/references.ts";
import type { SeedreamOperation } from "#lib/shared/image-studio/seedream.ts";
import { releasedImageModels, zImageModel } from "#lib/shared/media-catalog/registry.ts";
import { css } from "#styled-system/css";
import { studioPanel } from "#styled-system/recipes";
import ImageReferencePreview from "./ImageReferencePreview.svelte";
import {
	fieldHeading,
	requestControl,
	requestField,
	requestLabel,
	requestLink,
} from "./request-styles.ts";

const id = $props.id();
let {
	model,
	onModel,
	fields,
	reviewPanel,
	reviewHref,
	operation,
	reference,
	previewIndex,
}: {
	model: (typeof releasedImageModels)[number];
	onModel: (model: string) => void;
	fields: Snippet;
	reviewPanel: Snippet;
	reviewHref: string;
	operation: SeedreamOperation;
	reference: SeedreamReference | undefined;
	previewIndex: number;
} = $props();
let preview: ReturnType<typeof ImageReferencePreview>;
export function focusPreview() {
	preview.focus();
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
						>{model.family}</span
					>
				</div>
				<select
					class={requestControl}
					id={`${id}-model`}
					aria-describedby={`${id}-family`}
					value={model.id}
					onchange={(event) => onModel(event.currentTarget.value)}
				>
					{#each releasedImageModels as choice (choice.id)}
						<optgroup label={choice.family}>
							<option value={choice.id}>{choice.label}</option>
						</optgroup>
					{/each}
				</select>
			</div>

			{@render fields()}
		</section>
		<div class={css({ display: "grid", minWidth: 0, gap: "1rem" })}>
			<ImageReferencePreview
				bind:this={preview}
				urlOnly={model.id === zImageModel.id}
				{operation}
				index={previewIndex}
				{reference}
			/>
			{@render reviewPanel()}
		</div>
	</div>
</div>
