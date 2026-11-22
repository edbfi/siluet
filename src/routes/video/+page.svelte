<script lang="ts">
import { untrack } from "svelte";
import * as style from "#lib/components/image-studio/image-review-styles.ts";
import {
	requestControl,
	requestField,
	requestFields,
	requestFieldset,
	requestLabel,
	requestLegend,
} from "#lib/components/image-studio/request-styles.ts";
import {
	reviewPriceExpiry,
	reviewPriceReason,
	watchReviewExpiry,
} from "#lib/shared/image-studio/review-price.ts";
import { releasedModels, releasedVideoOperations } from "#lib/shared/media-catalog/registry.ts";
import type { PriceEstimate } from "#lib/shared/pricing/estimate.ts";
import { videoDefaults, videoRatios } from "#lib/shared/video-studio/seedance.ts";
import { css, cx } from "#styled-system/css";
import { studioButton } from "#styled-system/recipes";
import { goto } from "$app/navigation";
import type { PageProps } from "./$types";

let { data }: PageProps = $props();
type Operation = (typeof releasedVideoOperations)[number];
const find = (model: string) => releasedVideoOperations.find((entry) => entry.key.model === model);
const range = (min: number, max: number) =>
	Array.from({ length: max - min + 1 }, (_, index) => min + index);

// A Poyo descriptor lists its reviewed inputs. Seedance keeps its own controls and audio.
function controls(operation: Operation) {
	if (!("descriptor" in operation))
		return {
			durations: range(4, 10),
			resolutions: ["480p", "720p"],
			ratios: [...videoRatios] as string[],
			defaults: videoDefaults as Record<string, string | number | boolean>,
			audio: true,
		};
	const { duration, resolution, aspect_ratio } = operation.descriptor.fields;
	return {
		durations: range(duration.min, duration.max),
		resolutions: [...resolution.values] as string[],
		ratios: [...aspect_ratio.values] as string[],
		defaults: operation.descriptor.defaults as Record<string, string | number | boolean>,
		audio: false,
	};
}

let operation = $state(untrack(() => find(data.initialModel) ?? releasedVideoOperations[0]));
const current = $derived(controls(operation));
const poyo = $derived(operation.key.provider === "poyo");
const model = $derived(releasedModels.find((entry) => entry.id === operation.modelId));
const title = $derived(`${model?.label} · ${poyo ? "Poyo.ai" : "ToAPIs"}`);
let draft = $state(
	untrack(() => ({ ...videoDefaults, ...controls(operation).defaults, prompt: "" })),
);
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
// Keep the prompt and any compatible setting. Apply the target's defaults to the rest.
function switchModel(model: string) {
	const target = find(model);
	if (!target || target === operation) return;
	operation = target;
	const next = controls(target);
	draft = {
		prompt: draft.prompt,
		aspect_ratio: next.ratios.includes(draft.aspect_ratio)
			? draft.aspect_ratio
			: String(next.defaults.aspect_ratio),
		duration: next.durations.includes(draft.duration)
			? draft.duration
			: Number(next.defaults.duration),
		resolution: next.resolutions.includes(draft.resolution)
			? draft.resolution
			: String(next.defaults.resolution),
		generate_audio: videoDefaults.generate_audio,
	};
	edit();
}
function requestDraft() {
	if (current.audio) return draft;
	const { prompt, duration, resolution, aspect_ratio } = draft;
	return { prompt, duration, resolution, aspect_ratio };
}
// An expired estimate withdraws consent and needs a fresh Review.
$effect(() => {
	const expiresAt = reviewPriceExpiry(reviewed?.quote);
	if (!reviewed || expiresAt === undefined) return;
	const watch = watchReviewExpiry(expiresAt, (time) => {
		if (time < expiresAt) return;
		reviewed = null;
		acceptTerms = false;
		notice = "The reviewed rates expired. Review the request again before queuing.";
	});
	window.addEventListener("focus", watch.refresh);
	document.addEventListener("visibilitychange", watch.refresh);
	return () => {
		watch.stop();
		window.removeEventListener("focus", watch.refresh);
		document.removeEventListener("visibilitychange", watch.refresh);
	};
});
async function act(queue: boolean) {
	if (pending || promptError || (queue && (!reviewed || !acceptTerms))) return;
	pending = true;
	try {
		const response = await fetch(queue ? "/video/queue" : "/video/review", {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({
				draft: requestDraft(),
				operationKey: operation.key,
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
			<label class={requestField}
				><span class={requestLabel}>Video model and provider</span>
				<select
					class={requestControl}
					value={operation.key.model}
					disabled={pending}
					onchange={(event) => switchModel(event.currentTarget.value)}
				>
					{#each data.routes as family (family.label)}
						<optgroup label={family.label}>
							{#each family.routes as route (route.id)}
								<option value={route.id} disabled={!!route.reason}>
									{route.label}{route.reason ? ` (${route.reason})` : ""}
								</option>
							{/each}
						</optgroup>
					{/each}
				</select></label
			>
			<p class={style.note}>{model?.family}</p>
			<h2 class={style.heading}>{title}</h2>
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
					{#each current.ratios as ratio (ratio)}
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
						{#each current.durations as s (s)}
							<option value={s}>{s}</option>
						{/each}
					</select></label
				>
				<label class={requestField}
					>Resolution<select class={requestControl} bind:value={draft.resolution}>
						{#each current.resolutions as resolution (resolution)}
							<option>{resolution}</option>
						{/each}
					</select></label
				>
			</div>
			{#if current.audio}
				<details>
					<summary>Advanced options</summary>
					<label><input type="checkbox" bind:checked={draft.generate_audio}> Generate audio</label>
				</details>
			{/if}
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
			<p>Create video · {title}{poyo ? "" : " · MP4"}</p>
			<p>1 potentially billable submission</p>
			{#if reviewed.quote.status === "known" && reviewed.quote.unit === "poyo_credit"}
				<p>
					Estimated {reviewed.quote.perRequest} Poyo.ai credits ·
					<a
						href={`https://github.com/PoyoAPI/poyo-devtools/blob/${reviewed.quote.revision}/artifacts/capability-catalog.json`}
						rel="noreferrer"
						>Public catalog, {reviewed.quote.sourceDate.slice(0, 10)}</a
					>
				</p>
				<p class={style.note}>
					Public list rates can differ from the charge on your account. Task credits and wallet
					changes appear in Jobs.
				</p>
			{:else if reviewed.quote.status === "unknown"}
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
				<p>{operation.key.route}</p>
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
					><input type="checkbox" disabled={pending} bind:checked={acceptTerms}>
					{poyo
						? reviewed.quote.status === "known"
							? "I accept the estimate and Gallery Save limitations."
							: "I accept the unknown price and Gallery Save limitations."
						: "I accept the unknown charge, routing terms and Gallery Save limitations."}</label
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
			{poyo
				? "Poyo.ai confirms account access through your balance check. H3 Max access for this key is unverified until Poyo.ai accepts a request."
				: "Poyo.ai Seedance 2.5 cannot accept the studio’s fixed filtering setting."}
			<a href={`/settings/providers?provider=${operation.key.provider}`}
				>{poyo ? "Poyo.ai" : "ToAPIs"} settings</a
			>
		</p>
	</section>
</div>
