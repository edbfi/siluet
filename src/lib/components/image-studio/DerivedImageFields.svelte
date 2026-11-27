<script lang="ts">
import { type DerivedDraft, fieldLabel } from "#lib/shared/image-studio/derived.ts";
import { refusedValues } from "#lib/shared/image-studio/derived-review.ts";
import type { QueueField, QueueRow } from "#lib/shared/media-catalog/queue-row.ts";
import { css } from "#styled-system/css";
import ImagePrompt from "./ImagePrompt.svelte";
import {
	requestControl,
	requestError,
	requestField,
	requestFields,
	requestHelp,
	requestLabel,
	requestLink,
} from "./request-styles.ts";

let {
	draft = $bindable(),
	row,
	connected,
	errors = {},
}: {
	draft: DerivedDraft;
	row: QueueRow;
	connected: boolean;
	errors?: Partial<Record<string, string>>;
} = $props();
const id = $props.id();
// A value the row's combinations refuse beside the current choices is offered but disabled.
const refused = $derived(refusedValues(row, draft.options));
const sentence = (text: string) => `${text.charAt(0).toUpperCase()}${text.slice(1)}`;
const valueLabel = (field: QueueField, value: unknown) =>
	field.wire === "output_format" ? String(value).toUpperCase() : String(value);
const hint = $derived(
	`${row.prompt.min.toLocaleString("en-US")}–${row.prompt.max.toLocaleString("en-US")} characters`,
);
function choose(field: QueueField, text: string) {
	const value = field.values?.find((offered) => String(offered) === text);
	if (value !== undefined) draft.options = { ...draft.options, [field.wire]: value };
}
// An empty seed is left out of the request; anything else is checked as a whole number.
function enter(field: QueueField, text: string) {
	const { [field.wire]: _previous, ...rest } = draft.options;
	const trimmed = text.trim();
	draft.options =
		trimmed === ""
			? rest
			: { ...rest, [field.wire]: /^-?\d+$/.test(trimmed) ? Number(trimmed) : trimmed };
}
</script>
<div class={requestFields}>
	<div class={requestField}>
		<span class={requestLabel}>API provider</span>
		{#if connected}
			<span>Poyo.ai</span>
		{:else}
			<a
				class={css(requestLink, {
					display: "inline-flex",
					alignItems: "center",
					width: "fit-content",
					minHeight: "44px",
				})}
				href="/settings/providers"
				>Connect Poyo.ai in Settings</a
			>
		{/if}
	</div>
	<div class={requestField}>
		<span class={requestLabel}>Operation</span>
		<span>Create image</span>
	</div>
</div>
<ImagePrompt bind:prompt={draft.prompt} operation="generate" error={errors.prompt} {hint} />
{#if !row.prompt.documented}
	<p class={requestHelp}>
		Poyo.ai documents no prompt limit for this model, so Siluet keeps its own
		{row.prompt.max.toLocaleString("en-US")}-character limit.
	</p>
{/if}
{#if row.fields.length}
	<div class={requestFields} data-derived-fields>
		{#each row.fields as field (field.wire)}
			{#if field.kind === "enum"}
				<div class={[requestField, requestLabel]}>
					<label for={`${id}-${field.wire}`}>{sentence(fieldLabel(field.wire))}</label>
					<select
						class={requestControl}
						id={`${id}-${field.wire}`}
						value={String(draft.options[field.wire] ?? "")}
						aria-invalid={!!errors[field.wire]}
						onchange={(event) => choose(field, event.currentTarget.value)}
					>
						{#each field.values ?? [] as value (String(value))}
							<option value={String(value)} disabled={refused[field.wire]?.includes(value)}>
								{valueLabel(field, value)}
							</option>
						{/each}
					</select>
					{#if errors[field.wire]}
						<p class={requestError} role="status">{errors[field.wire]}</p>
					{/if}
				</div>
			{:else if field.kind === "boolean"}
				<label
					class={[
						requestLabel,
						css({ display: "flex", alignItems: "center", gap: "0.5rem", minHeight: "44px" }),
					]}
					><input
						class={css({ accentColor: "accent" })}
						type="checkbox"
						checked={draft.options[field.wire] === true}
						onchange={(event) =>
							(draft.options = { ...draft.options, [field.wire]: event.currentTarget.checked })}
					>
					{sentence(fieldLabel(field.wire))}</label
				>
			{:else}
				<div class={[requestField, requestLabel]}>
					<label for={`${id}-${field.wire}`}
						>{sentence(fieldLabel(field.wire))}{field.optional ? " (optional)" : ""}</label
					>
					<input
						class={requestControl}
						id={`${id}-${field.wire}`}
						inputmode="numeric"
						autocomplete="off"
						value={String(draft.options[field.wire] ?? "")}
						aria-invalid={!!errors[field.wire]}
						oninput={(event) => enter(field, event.currentTarget.value)}
					>
					{#if errors[field.wire]}
						<p class={requestError} role="status">{errors[field.wire]}</p>
					{:else if field.optional}
						<p class={requestHelp}>Leave it empty for a random seed.</p>
					{/if}
				</div>
			{/if}
		{/each}
	</div>
{/if}
