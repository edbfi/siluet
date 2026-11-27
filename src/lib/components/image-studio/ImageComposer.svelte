<script lang="ts">
import type { Snippet } from "svelte";
import type { SeedreamReference } from "#lib/shared/image-studio/references.ts";
import type { SeedreamOperation } from "#lib/shared/image-studio/seedream.ts";
import { reviewOnlyFamily, reviewOnlyImageRows } from "#lib/shared/media-catalog/picker.ts";
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
	setAside,
} from "./request-styles.ts";

const id = $props.id();
let {
	modelId,
	family,
	reviewOnly,
	locked,
	onModel,
	fields,
	reviewPanel,
	reviewHref,
	operation,
	reference,
	previewIndex,
}: {
	/** The selected shipped model or derived row. */
	modelId: string;
	family: string;
	/** A derived row is selected: it has no request to preview. */
	reviewOnly: boolean;
	/** A Review or Queue is in flight, so the model stays put. */
	locked: boolean;
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
					<span class={css({ color: "muted", fontWeight: 500 })} id={`${id}-family`}>{family}</span>
				</div>
				<select
					class={requestControl}
					id={`${id}-model`}
					aria-describedby={`${id}-family`}
					value={modelId}
					disabled={locked}
					onchange={(event) => onModel(event.currentTarget.value)}
				>
					{#each releasedImageModels as choice (choice.id)}
						<optgroup label={choice.family}>
							<option value={choice.id}>{choice.label}</option>
						</optgroup>
					{/each}
					<optgroup label={reviewOnlyFamily("image")}>
						{#each reviewOnlyImageRows as row (row.model)}
							<option value={row.model}>{row.model} (Review only: {row.reason})</option>
						{/each}
					</optgroup>
				</select>
			</div>

			{@render fields()}
		</section>
		<div class={css({ display: "grid", minWidth: 0, gap: "1rem" })}>
			<div class={setAside} hidden={reviewOnly}>
				<ImageReferencePreview
					bind:this={preview}
					urlOnly={modelId === zImageModel.id}
					{operation}
					index={previewIndex}
					{reference}
				/>
			</div>
			{@render reviewPanel()}
		</div>
	</div>
</div>
