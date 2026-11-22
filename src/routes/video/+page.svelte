<script lang="ts">
import * as style from "#lib/components/image-studio/image-review-styles.ts";
import {
	requestControl,
	requestField,
	requestFields,
	requestFieldset,
	requestLabel,
	requestLegend,
} from "#lib/components/image-studio/request-styles.ts";
import { reviewPriceReason } from "#lib/shared/image-studio/review-price.ts";
import { seedanceOperation } from "#lib/shared/media-catalog/registry.ts";
import type { PriceEstimate } from "#lib/shared/pricing/estimate.ts";
import { videoDefaults, videoRatios } from "#lib/shared/video-studio/seedance.ts";
import { css, cx } from "#styled-system/css";
import { studioButton } from "#styled-system/recipes";
import { goto } from "$app/navigation";

let draft = $state({ ...videoDefaults });
let reviewed = $state<{
	token: string;
	quote: PriceEstimate;
	preview: Record<string, unknown>;
	disclosures: string[];
	blockers: string[];
} | null>(null);
let acceptTerms = $state(false);
let pending = $state(false);
let notice = $state("");
const edges = $derived(draft.aspect_ratio.split(":").map(Number));
const size = $derived(new TextEncoder().encode(draft.prompt.trim()).length);
const promptError = $derived(
	size > 4000 ? "Shorten the prompt to 4,000 UTF-8 bytes." : !size ? "Enter a video prompt." : "",
);
function edit() {
	reviewed = null;
	acceptTerms = false;
	notice = "";
}
async function act(queue: boolean) {
	if (pending || promptError || (queue && (!reviewed || !acceptTerms))) return;
	pending = true;
	try {
		const response = await fetch(queue ? "/video/queue" : "/video/review", {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({
				draft,
				operationKey: seedanceOperation.key,
				count: 1,
				retryLimit: 0,
				acceptTerms,
				...(queue && { token: reviewed?.token }),
			}),
		});
		if (!response.ok) {
			if (queue && response.status === 429) {
				const result = await response.json();
				if (result.error === "cooldown" && Number.isFinite(result.until)) {
					notice = `Nothing sent. Provider cooldown until ${new Date(result.until).toISOString()}. Retry this reviewed request after that time.`;
					return;
				}
			}
			if (queue && response.status >= 500) throw new Error("Queue interrupted.");
			edit();
			notice = "Review the current request and its terms again.";
			return;
		}
		const result = await response.json();
		if (queue) await goto(`/jobs#job-${encodeURIComponent(result.jobId)}`);
		else {
			reviewed = result;
			acceptTerms = false;
			notice = "Request reviewed.";
		}
	} catch {
		notice = queue
			? "The Queue response was interrupted. Retry the same reviewed request or check Jobs."
			: "Review is unavailable. Try again.";
	} finally {
		pending = false;
	}
}
const columns = css({
	display: "grid",
	gap: "1rem",
	alignItems: "start",
	gridTemplateColumns: "minmax(0,1fr)",
	"@media(min-width: 980px)": { gridTemplateColumns: "minmax(0,1.25fr) minmax(0,1fr)" },
});
const frame = css({
	marginInline: "auto",
	width: "min(100%,var(--frame-width))",
	maxHeight: "14rem",
	border: "1px solid {colors.line}",
	background: "canvas",
	display: "grid",
	placeItems: "center",
	color: "muted",
	borderRadius: "6px",
});
</script>
<svelte:head><title>Video Studio · Siluet</title></svelte:head>
<h1>Video Studio</h1>
<div class={columns}>
	<form
		class={style.panel}
		oninput={edit}
		onsubmit={(e) => {
			e.preventDefault();
			void act(false);
		}}
	>
		<header>
			<p class={style.note}>ByteDance / Seedance</p>
			<h2 class={style.heading}>Seedance 2.5 · ToAPIs</h2>
			<p>Create video</p>
		</header>
		<fieldset disabled={pending} class={cx(requestFieldset, css({ display: "grid", gap: "1rem" }))}>
			<label class={requestField}
				><span class={requestLabel}>Prompt</span
				><textarea
					autocomplete="off"
					rows="4"
					class={requestControl}
					required
					bind:value={draft.prompt}
					aria-describedby="prompt-help"
					aria-invalid={!!promptError && !!draft.prompt}
				></textarea></label
			>
			<p class={style.note} id="prompt-help">{promptError || `${size} of 4,000 UTF-8 bytes`}</p>
			<fieldset class={requestFieldset}>
				<legend class={requestLegend}>Aspect ratio</legend>
				<div class={style.actions}>
					{#each videoRatios as ratio (ratio)}
						<label
							><input type="radio" name="ratio" value={ratio} bind:group={draft.aspect_ratio}>
							{ratio}</label
						>
					{/each}
				</div>
			</fieldset>
			<div
				class={frame}
				style:--frame-width={`${14 * Math.min(1, edges[0] / edges[1])}rem`}
				style:aspect-ratio={draft.aspect_ratio.replace(":", "/")}
			>
				Framing · {draft.aspect_ratio}
			</div>
			<div class={requestFields}>
				<label class={requestField}
					>Duration (seconds)<select class={requestControl} bind:value={draft.duration}>
						{#each [4, 5, 6, 7, 8, 9, 10] as s (s)}
							<option value={s}>{s}</option>
						{/each}
					</select></label
				>
				<label class={requestField}
					>Resolution<select class={requestControl} bind:value={draft.resolution}>
						<option>480p</option>
						<option>720p</option>
					</select></label
				>
			</div>
			<details>
				<summary>Advanced options</summary>
				<label><input type="checkbox" bind:checked={draft.generate_audio}> Generate audio</label>
			</details>
			<button
				type="submit"
				class={studioButton()}
				disabled={!!promptError}
				aria-describedby="prompt-help"
			>
				Review request
			</button>
		</fieldset>
	</form>
	<section class={style.panel} aria-labelledby="video-review">
		<h2 class={style.heading} id="video-review">Review</h2>
		<p role="status">{notice}</p>
		{#if reviewed}
			<p>Create video · Seedance 2.5 · ToAPIs · MP4</p>
			<p>1 potentially billable submission</p>
			{#if reviewed.quote.status === "unknown"}
				<p>Total unknown. {reviewPriceReason(reviewed.quote)}</p>
				{#if reviewed.quote.advertisedUnitRate}
					{@const rate = reviewed.quote.advertisedUnitRate}
					<p>
						Public rate · ${rate.usd} per million total tokens ·
						<a href={rate.source.url} rel="noreferrer">ToAPIs, {rate.sourceDate.slice(0, 10)}</a>
					</p>
				{/if}
			{/if}
			<details>
				<summary>Outgoing request</summary>
				<p>POST /v1/videos/generations</p>
				<pre class={cx(style.json, style.wire)}>{JSON.stringify(reviewed.preview, null, 2)}</pre>
			</details>
			<ul class={style.disclosure}>
				{#each reviewed.disclosures as disclosure (disclosure)}
					<li>{disclosure}</li>
				{/each}
			</ul>
			<div id="queue-terms">
				{#each reviewed.blockers as blocker (blocker)}
					<p>{blocker}</p>
				{/each}
				<label
					><input type="checkbox" disabled={pending} bind:checked={acceptTerms}> I accept the
					unknown charge, routing terms and Gallery Save limitations.</label
				>
			</div>
			<button
				type="button"
				class={cx(studioButton(), style.queue)}
				disabled={pending || !acceptTerms || !!reviewed.blockers.length}
				aria-describedby="queue-terms"
				onclick={() => act(true)}
			>
				Queue 1 request
			</button>
		{:else}
			<p>Review the prompt and settings before queuing one request.</p>
		{/if}
		<p class={style.note}>
			Poyo.ai Seedance 2.5 cannot accept the studio’s fixed filtering setting.
			<a href="/settings/providers?provider=toapis">ToAPIs settings</a>
		</p>
	</section>
</div>
