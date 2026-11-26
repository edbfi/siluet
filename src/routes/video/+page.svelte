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
import ReviewOnlyPanel from "#lib/components/media-catalog/ReviewOnlyPanel.svelte";
import KeyframeFields from "#lib/components/video-studio/KeyframeFields.svelte";
import {
	reviewPriceExpiry,
	reviewPriceReason,
	watchReviewExpiry,
} from "#lib/shared/image-studio/review-price.ts";
import { reviewOnlyFamily, reviewOnlyVideoRows } from "#lib/shared/media-catalog/picker.ts";
import { releasedModels, releasedVideoOperations } from "#lib/shared/media-catalog/registry.ts";
import type { PriceEstimate } from "#lib/shared/pricing/estimate.ts";
import {
	duplicateFrames,
	type FrameRole,
	frameUrlProblem,
	keyframeAcceptance,
} from "#lib/shared/video-studio/keyframes.ts";
import { videoDefaults, videoRatios } from "#lib/shared/video-studio/seedance.ts";
import { editAcceptance } from "#lib/shared/video-studio/source-edit.ts";
import { css, cx } from "#styled-system/css";
import { studioButton } from "#styled-system/recipes";
import { goto } from "$app/navigation";
import type { PageProps } from "./$types";

let { data }: PageProps = $props();
type Operation = (typeof releasedVideoOperations)[number];
// A model's first operation is its plain generation, so a model switch starts there.
const find = (model: string, operation?: string) =>
	releasedVideoOperations.find(
		(entry) => entry.key.model === model && (!operation || entry.key.operation === operation),
	);
const frameRoles = (operation: Operation): readonly FrameRole[] =>
	"roles" in operation ? operation.roles : [];
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

// Raw: registry entries are compared by identity and never mutated.
let operation = $state.raw(untrack(() => find(data.initialModel) ?? releasedVideoOperations[0]));
const current = $derived(controls(operation));
const poyo = $derived(operation.key.provider === "poyo");
const model = $derived(releasedModels.find((entry) => entry.id === operation.modelId));
const title = $derived(`${model?.label} · ${poyo ? "Poyo.ai" : "ToAPIs"}`);
const modes = $derived(
	releasedVideoOperations.filter(
		(entry) =>
			entry.key.provider === operation.key.provider && entry.key.model === operation.key.model,
	),
);
const roles = $derived(frameRoles(operation));
// An edit's length and framing follow its source clip.
const editing = $derived(operation.mode === "edit");
// Frame URLs live only in this page's memory and the reviewed request.
const noFrames = (): Record<FrameRole, string> => ({
	first_frame: "",
	last_frame: "",
	reference_video: "",
});
let frames = $state(noFrames());
const frameErrors = $derived.by(() => {
	const errors: Partial<Record<FrameRole, string>> = {};
	for (const role of roles) {
		const problem = frameUrlProblem(role, frames[role]);
		if (problem) errors[role] = problem;
	}
	if (
		roles.length === 2 &&
		!errors.first_frame &&
		!errors.last_frame &&
		frames.first_frame.trim() === frames.last_frame.trim()
	)
		errors.last_frame = duplicateFrames;
	return errors;
});
const frameError = $derived(roles.map((role) => frameErrors[role]).find(Boolean) ?? "");
let draft = $state(
	untrack(() => ({ ...videoDefaults, ...controls(operation).defaults, prompt: "" })),
);
let reviewed = $state<{
	token: string;
	quote: PriceEstimate;
	preview: Record<string, unknown>;
	frames: string[];
	disclosures: string[];
	blockers: string[];
} | null>(null);
let acceptTerms = $state(false);
let pending = $state(false);
let notice = $state("");
// The exact body of a Queue whose outcome is unknown. Expiry and edits keep it for a byte-for-byte retry.
let attempt = $state<string | null>(null);
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
// Another operation of the same model keeps the prompt and settings and clears the frames.
function switchMode(key: string) {
	const target = find(operation.key.model, key);
	if (!target || target === operation) return;
	operation = target;
	frames = noFrames();
	edit();
}
// A derived row is Review-only. Choosing it sets the shipped draft aside, so nothing can queue.
let reviewOnly = $state.raw<(typeof reviewOnlyVideoRows)[number] | null>(null);
// Keep the prompt and any compatible setting. Apply the target's defaults to the rest.
function switchModel(id: string) {
	reviewOnly = reviewOnlyVideoRows.find((row) => row.model === id) ?? null;
	if (reviewOnly) return edit();
	const target = find(id);
	if (!target || target === operation) return;
	operation = target;
	frames = noFrames();
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
	if (roles.length) {
		const { prompt, duration, resolution, generate_audio } = draft;
		const slots = roles.map((role) => ({ role, url: frames[role] }));
		if (editing) return { prompt, resolution, generate_audio, frames: slots };
		return { prompt, duration, resolution, generate_audio, frames: slots };
	}
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
		// An interrupted Queue may already be claimed; its retry is the safe next step.
		notice = attempt
			? "The reviewed rates expired. Retry the interrupted request or check Jobs before reviewing again."
			: "The reviewed rates expired. Review the request again before queuing.";
	});
	window.addEventListener("focus", watch.refresh);
	document.addEventListener("visibilitychange", watch.refresh);
	return () => {
		watch.stop();
		window.removeEventListener("focus", watch.refresh);
		document.removeEventListener("visibilitychange", watch.refresh);
	};
});
async function act(queue: boolean, replay?: string) {
	if (pending || reviewOnly) return;
	if (replay === undefined && (promptError || frameError || (queue && (!reviewed || !acceptTerms))))
		return;
	pending = true;
	const body =
		replay ??
		JSON.stringify({
			draft: requestDraft(),
			operationKey: operation.key,
			count: 1,
			retryLimit: 0,
			acceptTerms,
			...(queue && { token: reviewed?.token }),
		});
	try {
		const response = await fetch(queue ? "/video/queue" : "/video/review", {
			method: "POST",
			headers: { "content-type": "application/json" },
			body,
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
			// Only the Queue service's own refusal proves that a token was never claimed.
			// A session, origin or size refusal comes before the token is looked up.
			const refusal = queue ? await response.json().catch(() => null) : null;
			const unclaimed = refusal?.error === "stale" || refusal?.error === "invalid";
			if (replay !== undefined) {
				if (!unclaimed) {
					notice =
						"The retry could not be confirmed. Sign in again if needed, then check Jobs before queuing.";
					return;
				}
				attempt = null;
				// A newer Review keeps its consent; the refused one does not.
				if (JSON.parse(replay).token !== reviewed?.token) {
					notice = "The interrupted request was never queued. Nothing was sent.";
					return;
				}
				edit();
				notice =
					"The interrupted request was never queued. Nothing was sent. Review the request again before queuing.";
				return;
			}
			if (unclaimed && body === attempt) attempt = null;
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
		if (queue) attempt = body;
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
					value={reviewOnly?.model ?? operation.key.model}
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
					<optgroup label={reviewOnlyFamily("video")}>
						{#each reviewOnlyVideoRows as row (row.model)}
							<option value={row.model}>{row.model} (Review only: {row.reason})</option>
						{/each}
					</optgroup>
				</select></label
			>
			<p class={style.note}>{reviewOnly ? reviewOnlyFamily(reviewOnly.media) : model?.family}</p>
			<h2 class={style.heading}>{reviewOnly ? `${reviewOnly.model} · Poyo.ai` : title}</h2>
			{#if reviewOnly}
				<!-- The Review panel names why this row cannot queue. -->
			{:else if modes.length > 1}
				<fieldset class={requestFieldset} disabled={pending}>
					<legend class={requestLegend}>Operation</legend>
					<div class={style.actions}>
						{#each modes as mode (mode.key.operation)}
							<label
								><input
									type="radio"
									name="operation"
									value={mode.key.operation}
									checked={mode.key.operation === operation.key.operation}
									onchange={() => switchMode(mode.key.operation)}
								>
								{mode.label}</label
							>
						{/each}
					</div>
				</fieldset>
			{:else}
				<p>{operation.label}</p>
			{/if}
		</header>
		{#if !reviewOnly}
			<fieldset
				disabled={pending}
				class={cx(requestFieldset, css({ display: "grid", gap: "1rem" }))}
			>
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
				{#if roles.length}
					<KeyframeFields {roles} bind:values={frames} errors={frameErrors} />
				{:else}
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
				{/if}
				<div class={requestFields}>
					{#if !editing}
						<label class={requestField}
							>Duration (seconds)<select class={requestControl} bind:value={draft.duration}>
								{#each current.durations as s (s)}
									<option value={s}>{s}</option>
								{/each}
							</select></label
						>
					{/if}
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
						<label
							><input type="checkbox" bind:checked={draft.generate_audio}> Generate audio</label
						>
					</details>
				{/if}
				<button
					type="submit"
					class={studioButton()}
					disabled={!!promptError || !!frameError}
					aria-describedby={["prompt-help", ...roles.map((role) => `${role}-help`)].join(" ")}
				>
					Review request
				</button>
			</fieldset>
		{/if}
	</form>
	{#if reviewOnly}
		<ReviewOnlyPanel row={reviewOnly} headingId="video-review" title="Review" />
	{:else}
		<section class={style.panel} aria-labelledby="video-review">
			<h2 class={style.heading} id="video-review">Review</h2>
			<p role="status">{notice}</p>
			{#if attempt}
				<p id="queue-retry">The retry sends the interrupted request unchanged.</p>
				<button
					type="button"
					class={studioButton()}
					disabled={pending}
					aria-describedby="queue-retry"
					onclick={() => act(true, attempt ?? undefined)}
				>
					Retry the interrupted request
				</button>
			{/if}
			{#if reviewed}
				<p>{operation.label} · {title}{poyo ? "" : " · MP4"}</p>
				<p>1 potentially billable submission</p>
				{#if reviewed.frames.length}
					<p>One clip, zero retries, zero uploads</p>
					<ul
						class={cx(style.mediaList, style.detail)}
						aria-label={editing ? "Source clip" : "Frames"}
					>
						{#each reviewed.frames as frame (frame)}
							<li>{frame}</li>
						{/each}
					</ul>
				{/if}
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
							: editing
								? editAcceptance
								: roles.length
									? keyframeAcceptance
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
	{/if}
</div>
