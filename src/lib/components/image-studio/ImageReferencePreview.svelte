<script lang="ts">
import sampleImage from "#lib/assets/tide-study.webp";
import type { SeedreamReference } from "#lib/shared/image-studio/references.ts";
import type { SeedreamOperation } from "#lib/shared/image-studio/seedream.ts";

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

<figure bind:this={figure} tabindex="-1">
	<div class="stage">
		{#if operation === "generate"}
			<img src={sampleImage} alt="An amber lamp at the water’s edge at blue hour">
		{:else if objectUrl && file && !failed}
			{#key objectUrl}
				<img
					src={objectUrl}
					alt={label}
					onerror={() => {
						failed = true;
					}}
				>
			{/key}
		{:else if failed && file}
			<p>Preview unavailable for this file.</p>
		{:else if reference?.kind === "url"}
			<p>Previews are available for local files.</p>
		{:else}
			<p>Choose an image to preview it here.</p>
		{/if}
	</div>
	<figcaption><strong>{title}</strong><span>{label}</span></figcaption>
</figure>

<style>
figure {
	min-width: 0;
	margin: 0;
	overflow: clip;
	border: 1px solid var(--line);
	border-radius: 15px;
	background: var(--surface);
}
.stage {
	display: grid;
	aspect-ratio: 3 / 2;
	place-items: center;
	overflow: hidden;
	background: color-mix(in srgb, var(--canvas) 55%, var(--line));
}
img {
	display: block;
	width: 100%;
	height: 100%;
	min-width: 0;
	min-height: 0;
	object-fit: contain;
}
p {
	max-width: 28ch;
	padding: 0.75rem;
	color: var(--muted);
	font-size: 0.88rem;
	text-align: center;
}
figcaption {
	display: flex;
	align-items: baseline;
	flex-wrap: wrap;
	justify-content: space-between;
	gap: 0.25rem 1rem;
	padding: 0.66rem 0.9rem;
	color: var(--muted);
	font-size: 0.8rem;
	overflow-wrap: anywhere;
}
strong {
	color: var(--ink);
	font-size: 0.93rem;
}
</style>
