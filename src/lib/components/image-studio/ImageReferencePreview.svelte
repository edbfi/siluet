<script lang="ts">
import sampleImage from "#lib/assets/tide-study.webp";
import type { SeedreamReference } from "#lib/shared/image-studio/references.ts";
import type { SeedreamOperation } from "#lib/shared/image-studio/seedream.ts";
import { css } from "#styled-system/css";
import { studioPanel } from "#styled-system/recipes";

const previewImage = css({
	display: "block",
	width: "100%",
	height: "100%",
	minWidth: 0,
	minHeight: 0,
	objectFit: "contain",
});
const previewMessage = css({
	maxWidth: "28ch",
	padding: "0.75rem",
	color: "muted",
	fontSize: "0.88rem",
	textAlign: "center",
});

let {
	operation,
	reference,
	index,
}: {
	operation: SeedreamOperation;
	reference: SeedreamReference | undefined;
	index: number;
} = $props();

let objectUrl = $state<string>();
let failed = $state(false);
let figure: HTMLElement;
let file = $derived(reference?.kind === "file" ? reference.file : null);
let label = $derived(
	operation === "generate"
		? "Sample preview"
		: reference
			? `Reference image ${index + 1}`
			: "Source preview",
);
let title = $derived(
	operation === "generate"
		? "Tide study"
		: reference?.kind === "url"
			? reference.hostname
			: (file?.name ?? "No source selected"),
);

$effect(() => {
	failed = false;
	objectUrl = undefined;
	if (!file) return;
	const url = URL.createObjectURL(file);
	objectUrl = url;
	return () => URL.revokeObjectURL(url);
});

export function focus() {
	figure.focus();
}
</script>

<figure
	class={[studioPanel(), css({ minWidth: 0, margin: 0, overflow: "clip" })]}
	bind:this={figure}
	tabindex="-1"
>
	<div
		class={css({
			display: "grid",
			aspectRatio: "3 / 2",
			placeItems: "center",
			overflow: "hidden",
			backgroundColor: "color-mix(in srgb, {colors.canvas} 55%, {colors.line})",
		})}
	>
		{#if operation === "generate"}
			<img
				class={previewImage}
				src={sampleImage}
				alt="An amber lamp at the water’s edge at blue hour"
			>
		{:else if objectUrl && file && !failed}
			{#key objectUrl}
				<img
					class={previewImage}
					src={objectUrl}
					alt={label}
					onerror={() => {
						failed = true;
					}}
				>
			{/key}
		{:else if failed && file}
			<p class={previewMessage}>Preview unavailable for this file.</p>
		{:else if reference?.kind === "url"}
			<p class={previewMessage}>Previews are available for local files.</p>
		{:else}
			<p class={previewMessage}>Choose an image to preview it here.</p>
		{/if}
	</div>
	<figcaption
		class={css({
			display: "flex",
			alignItems: "baseline",
			flexWrap: "wrap",
			justifyContent: "space-between",
			gap: "0.25rem 1rem",
			padding: "0.66rem 0.9rem",
			color: "muted",
			fontSize: "0.8rem",
			overflowWrap: "anywhere",
		})}
	>
		<strong class={css({ color: "ink", fontSize: "0.93rem" })}>{title}</strong><span>{label}</span>
	</figcaption>
</figure>
