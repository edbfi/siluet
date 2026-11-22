<script lang="ts">
import { untrack } from "svelte";
import type { SeedreamOperation } from "#lib/shared/image-studio/seedream.ts";
import { css } from "#styled-system/css";
import {
	fieldHeading,
	requestError,
	requestField,
	requestHelp,
	requestLabel,
	requestLink,
} from "./request-styles.ts";

let {
	prompt = $bindable(),
	operation,
	error,
	hint,
}: { prompt: string; operation: SeedreamOperation; error?: string; hint?: string } = $props();
const id = $props.id();
let promptTouched = $state(untrack(() => prompt.length > 0));
let promptField: HTMLTextAreaElement;
function useExample() {
	prompt =
		operation === "generate"
			? "An amber signal lamp on a rocky tidal shelf at blue hour. Dark coastal hills silhouette the horizon over rippling water."
			: "Warm the horizon to copper and keep the amber lamp in place. Let the warmer light reflect across the water.";
	promptField.focus();
}
</script>
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
		bind:value={prompt}
		id={`${id}-prompt`}
		rows="4"
		required
		aria-invalid={promptTouched && !!error}
		aria-describedby={hint || (promptTouched && error) ? `${id}-prompt-help` : undefined}
		onblur={() => {
			promptTouched = true;
		}}
		placeholder={operation === "edit"
			? "Describe what should change and what should stay the same."
			: "Describe the subject, setting, and light."}
	></textarea>
	{#if promptTouched && error}
		<p class={requestError} id={`${id}-prompt-help`}>{error}</p>
	{:else if hint}
		<p class={requestHelp} id={`${id}-prompt-help`}>
			{hint}
		</p>
	{/if}
</div>
