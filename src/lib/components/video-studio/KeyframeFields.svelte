<script lang="ts">
import * as style from "#lib/components/image-studio/image-review-styles.ts";
import {
	requestControl,
	requestField,
	requestLabel,
} from "#lib/components/image-studio/request-styles.ts";
import { type FrameRole, frameLabels } from "#lib/shared/video-studio/keyframes.ts";

let {
	roles,
	values = $bindable(),
	errors,
}: {
	roles: readonly FrameRole[];
	values: Record<FrameRole, string>;
	errors: Partial<Record<FrameRole, string>>;
} = $props();
</script>

{#each roles as role (role)}
	<label class={requestField}
		><span class={requestLabel}>{frameLabels[role]}</span>
		<input
			type="text"
			inputmode="url"
			autocomplete="off"
			spellcheck="false"
			class={requestControl}
			required
			bind:value={values[role]}
			aria-describedby={`${role}-help`}
			aria-invalid={!!errors[role] && !!values[role]}
		></label
	>
	<p class={style.note} id={`${role}-help`}>
		{(values[role] && errors[role]) ||
			"Public HTTP or HTTPS image URL, up to 2,048 UTF-8 bytes. Siluet never opens it."}
	</p>
{/each}
<p class={style.note}>Framing follows the starting frame.</p>
