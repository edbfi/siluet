<script lang="ts">
import type { SeedreamProvider } from "#lib/shared/image-studio/seedream-options.ts";
import { css } from "#styled-system/css";
import { requestHelp } from "./request-styles.ts";

let { provider, autoFraming }: { provider: SeedreamProvider; autoFraming: boolean } = $props();
</script>

<div class={css({ display: "grid", gap: "0.25rem", marginBlockStart: "0.4rem" })}>
	<p class={requestHelp}>
		{provider === "poyo"
			? "Refer to “image 1” and “image 2” in the prompt using the order shown."
			: "ToAPIs receives URLs in the order shown. Numbered prompt references are unspecified."}
	</p>
	{#if provider === "poyo" && autoFraming}
		<p class={requestHelp}>
			With Follow references (Auto), Poyo.ai determines framing. Choose a fixed aspect ratio when
			framing matters.
		</p>
	{/if}
</div>
