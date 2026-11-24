<script lang="ts">
import { tick } from "svelte";
import { reviewPriceReason } from "#lib/shared/image-studio/review-price.ts";
import { seedreamProviderNames } from "#lib/shared/image-studio/seedream.ts";
import { releasedModels, releasedOperations } from "#lib/shared/media-catalog/registry.ts";
import { enhance, type SubmitFunction } from "$app/forms";
import { invalidate } from "$app/navigation";
import type { PageProps } from "./$types";
import { styles } from "./jobs-styles.ts";

let { data, form }: PageProps = $props();
type Action = "refresh" | "download" | "lookup";
let pending = $state<Record<string, Action | undefined>>({});
const outcomeLabels = {
	unsent: "Not submitted",
	pending: "Pending",
	uncertain: "May have been submitted",
	successful: "Successful",
	paused: "Tracking paused",
	failed: "Failed",
	rejected: "Rejected",
};
const stopReasons = {
	finished: "Dispatch finished.",
	expired: "The two-minute authorization expired.",
	terms: "Reviewed terms or credential changed.",
	rejection: "The provider rejected this payload.",
	interrupted: "Dispatch was interrupted.",
	cooldown: "The provider cooldown exceeded the dispatch window.",
};
const states = {
	unsent: "Not submitted",
	submitting: "Submitting",
	unknown: "May have been submitted",
	rejected: "Submission rejected",
	waiting: "Waiting",
	running: "Running",
	completed: "Completed",
	failed: "Job failed",
};
// A local-file edit's upload and edit boundary, when it says more than the job state.
const fileStates = {
	claimed: "Preparing upload",
	uploading: "Uploading file",
	uploaded: "File uploaded · preparing edit",
	editing: "Submitting edit",
	unsent: "No upload or edit sent",
	stored: "File uploaded · edit not sent",
	"upload-unknown": "Upload outcome unknown · edit not sent",
	"edit-unknown": "May have been submitted",
	"upload-rejected": "Upload rejected · edit not sent",
	"edit-recorded": null,
} as const;
type Job = PageProps["data"]["jobs"][number];
// What automatic Save has done with a completed result (D9).
function libraryText(job: Job) {
	const kind = job.video ? "video" : "image";
	switch (job.library) {
		case "waiting":
			return "Waiting to download";
		case "saving":
			return "Saving to Gallery";
		case "saved":
			return "Saved";
		case "failed":
			return "Download failed";
		case "removed":
			return "Removed from Gallery";
		case "unavailable":
			return "File missing from Gallery";
		case "unsupported":
			return `Not saved · this ${kind} is outside the Gallery profile`;
		case "webm":
			return "Not saved · WebM or Matroska. Gallery keeps MP4 files only.";
		case "expired":
			return "Not saved · the provider link has expired";
		case "needs-key":
			return "Download waits for the original API key";
		case "paused":
			return "Download paused until status is refreshed";
		default:
			return "";
	}
}
const walletReasons = {
	missing: "A balance reading is missing.",
	overlap: "Other jobs may have overlapped this attempt.",
	uncertain: "The submission outcome is uncertain.",
};
const clock = new Intl.DateTimeFormat("en", {
	year: "numeric",
	month: "short",
	day: "numeric",
	hour: "2-digit",
	minute: "2-digit",
	second: "2-digit",
	timeZone: "UTC",
});

// This reloads local history. Only the server schedules provider status reads.
$effect(() => {
	const { jobs, now } = data;
	const attempts = data.batches.flatMap((batch) =>
		batch.requests.flatMap((request) => request.attempts),
	);
	let delay = data.batches.some((batch) => !batch.reason) ? 2000 : Infinity;
	for (const job of [...jobs, ...attempts]) {
		// Automatic Save has no read schedule of its own here; check its local progress.
		if (
			job.tracking === "automatic" ||
			job.state === "submitting" ||
			job.library === "waiting" ||
			job.library === "saving"
		)
			delay = Math.min(delay, 2000);
		else if (job.nextReadAt && job.nextReadAt > now)
			delay = Math.min(delay, job.nextReadAt - now + 50);
		// Reload when a cooldown ends so its line disappears.
		if (job.submitAfter && job.submitAfter > now)
			delay = Math.min(delay, job.submitAfter - now + 50);
	}
	if (!Number.isFinite(delay)) return;
	const timer = window.setTimeout(
		() => void invalidate("studio:jobs"),
		Math.min(delay, 2_147_483_647),
	);
	return () => window.clearTimeout(timer);
});

function submit(id: string, action: Action): SubmitFunction {
	return ({ cancel }) => {
		if (pending[id]) {
			cancel();
			return;
		}
		pending[id] = action;
		return async ({ update }) => {
			try {
				await update({ navigate: false, refreshAll: true });
			} finally {
				delete pending[id];
			}
			// The download button is gone once the job is armed; keep keyboard focus on its status.
			if (action === "download") {
				await tick();
				document.getElementById(`job-${id}-library`)?.focus();
			}
		};
	};
}
</script>

<svelte:head><title>Jobs · Siluet</title></svelte:head>

{#snippet date(time: number)}
	<time datetime={new Date(time).toISOString()}>{clock.format(time)} UTC</time>
{/snippet}

{#snippet jobRow(job: Job)}
	{#if job}
		{@const entry = releasedOperations.find(
			(entry) =>
				entry.key.provider === job.provider &&
				entry.key.model === job.model &&
				(!job.operation || entry.key.operation === job.operation),
		)}
		{@const provider = seedreamProviderNames[job.provider]}
		{@const saved = job.library === "saved"}
		{@const unsaved = ["waiting", "saving", "failed", "needs-key", "paused"].includes(job.library)}
		{@const cooldown = job.nextReadAt && job.nextReadAt > data.now ? job.nextReadAt : null}
		<article class={styles.job} aria-labelledby={`job-${job.id}-title`} id={`job-${job.id}`}>
			<header>
				<div class={styles.header}>
					<svelte:element
						this={job.batchId ? "h4" : "h2"}
						class={styles.heading}
						id={`job-${job.id}-title`}
					>
						{job.batchId
							? `Attempt ${job.attempt}`
							: `${releasedModels.find((model) => model.id === entry?.modelId)?.label ?? job.model} · ${provider}`}
					</svelte:element>
					<span class={styles.state} data-state={job.state} aria-live="polite"
						>{job.throttled && job.batchId
							? "Not admitted · throttled"
							: ((job.filePhase && fileStates[job.filePhase]) ?? states[job.state])}</span
					>
				</div>
				<p class={styles.meta}>
					{#if job.operation && entry}
						{entry.label} ·
					{/if}
					Created {@render date(job.createdAt)}
					{job.taskId && job.batchId ? ` · Task ${job.taskId}` : ""}
				</p>
			</header>
			{#if job.progress != null}
				<p class={styles.meta}>{job.progress}% complete</p>
			{/if}
			{#if job.message}
				<p class={styles.note}>
					{job.tracking === "paused" ? "Tracking paused. " : ""}{job.message}
				</p>
			{/if}
			{#if job.filePhase &&
				job.filePhase !== "unsent" &&
				job.filePhase !== "upload-rejected" &&
				(job.state === "unknown" || job.state === "rejected")}
				<p class={styles.note}>
					An uploaded file may remain accessible. Check provider history before attaching it again.
					A new attempt can create another copy and incur charges.
				</p>
			{/if}
			{#if job.tracking === "manual"}
				<p class={styles.note}>
					Automatic tracking has ended. Refresh status to check the same task.
				</p>
			{/if}
			<dl class={styles.billing} aria-label="Billing">
				<div>
					<dt>
						{job.filePhase ? "Accepted edit estimate" : "Accepted estimate"}{job.provider ===
						"toapis"
							? " · standard route"
							: ""}
					</dt>
					<dd>
						{#if job.quote.status === "known"}
							{job.quote.perRequest} {provider} credits
							<span class={styles.meta}>(rates dated {job.quote.sourceDate.slice(0, 10)})</span>
						{:else}
							Unknown. {reviewPriceReason(job.quote)}
						{/if}
						{#if job.filePhase}
							<p class={styles.meta}>Upload cost unknown. Upload settlement timing is unknown.</p>
						{/if}
						{#if job.provider === "toapis"}
							<p class={styles.meta}>Fallback pricing unknown.</p>
						{/if}
					</dd>
				</div>
				<div>
					{#if job.billing?.status === "reported"}
						<dt>Provider-reported task credits</dt>
						<dd>{job.billing.credits} {provider} credits. Settlement unverified.</dd>
					{:else if job.billing?.status === "pending"}
						<dt>Provider billing</dt>
						<dd>Pending</dd>
					{:else if job.billing?.status === "settled" || job.billing?.status === "refunded"}
						<dt>{job.billing.status === "refunded" ? "Confirmed refund" : "Settled charge"}</dt>
						<dd>
							{#if job.billing.credits != null}
								{job.billing.credits} {provider} credits
							{/if}
							{#if job.billing.credits != null && job.billing.usd != null}
								·
							{/if}
							{#if job.billing.usd != null}
								${job.billing.usd} USD
							{/if}
							{#if job.billing.credits == null && job.billing.usd == null}
								Amount unknown
							{/if}
						</dd>
					{:else}
						<dt>
							{job.provider === "poyo" ? "Provider-reported task credits" : "Settled charge"}
						</dt>
						<dd>Unknown</dd>
					{/if}
				</div>
				{#if job.wallet && !job.batchId}
					<div>
						<dt>Account-wide wallet change</dt>
						<dd>
							{#if job.wallet.status === "observed"}
								{job.wallet.delta} credits ({job.wallet.before} before, {job.wallet.after} after).
								<p class={styles.meta}>
									Top-ups, reservations and other account activity can affect this balance.
								</p>
							{:else}
								Unavailable. {walletReasons[job.wallet.reason]}
							{/if}
						</dd>
					</div>
				{/if}
			</dl>
			{#if job.library !== "none"}
				<p
					class={styles.library}
					id={`job-${job.id}-library`}
					tabindex="-1"
					data-library={job.library}
					aria-live="polite"
				>
					{libraryText(job)}
				</p>
			{/if}
			{#if unsaved}
				<p class={styles.note}>
					{#if job.expiresAt}
						Provider result expires {@render date(job.expiresAt)}.
					{:else if job.video && job.provider === "poyo"}
						Poyo.ai keeps video content for three days after creation, and a file link can expire
						after 24 hours.
						{#if job.library === "waiting" || job.library === "saving"}
							Siluet downloads it as soon as the job completes.
						{/if}
					{:else}
						Expiry unknown. The provider keeps this result for a limited time.
					{/if}
				</p>
			{/if}
			{#if job.submitAfter !== null && job.submitAfter > data.now}
				<p class={styles.meta}>Next submission available after {@render date(job.submitAfter)}.</p>
			{/if}
			{#if cooldown && (job.canRefresh || job.canLookup || job.tracking === "automatic")}
				<p class={styles.meta}>Next status check available {@render date(cooldown)}.</p>
			{/if}
			{#if saved ||
				job.retryable ||
				job.canRefresh ||
				job.state === "unknown" ||
				(job.video && job.state === "unsent")}
				<div class={styles.actions}>
					{#if saved}
						<a class={styles.link} href={`/gallery/${encodeURIComponent(job.id)}`}
							>Open saved {job.video ? "video" : "image"}</a
						>
					{:else if job.retryable}
						<form method="POST" action="?/download" use:enhance={submit(job.id, "download")}>
							<input type="hidden" name="id" value={job.id}>
							<button class={styles.button} disabled={!!pending[job.id]} type="submit">
								{job.library === "failed" ? "Retry download" : "Download again"}
							</button>
						</form>
					{/if}
					{#if job.canRefresh}
						<form method="POST" action="?/refresh" use:enhance={submit(job.id, "refresh")}>
							<input type="hidden" name="id" value={job.id}>
							<button
								class={styles.button}
								disabled={!!pending[job.id] || cooldown !== null}
								type="submit"
							>
								{pending[job.id] === "refresh" ? "Checking…" : "Refresh status"}
							</button>
						</form>
					{/if}
					{#if job.state === "unknown" || (job.video && job.state === "unsent")}
						{#if job.canLookup}
							<form method="POST" action="?/lookup" use:enhance={submit(job.id, "lookup")}>
								<input type="hidden" name="id" value={job.id}>
								<button
									type="submit"
									class={styles.button}
									disabled={!!pending[job.id] || cooldown !== null}
								>
									Check submission
								</button>
							</form>
						{/if}
						<a
							class={styles.link}
							href={job.video ? `/video?model=${encodeURIComponent(job.model)}` : "/image"}
							>Review a new request</a
						>
					{/if}
				</div>
			{/if}
			{#if form && form.id === job.id && form.message}
				<p role="status" class={styles.note}>{form.message}</p>
			{/if}
		</article>
	{/if}
{/snippet}

<div class={styles.page}>
	<h1>Jobs</h1>
	<p class={styles.intro}>
		Track image and video requests. Siluet saves completed results to Gallery automatically.
	</p>
	<div class={styles.list}>
		{#each data.batches as batch (batch.id)}
			<section class={styles.job} id={`job-${batch.id}`} aria-label="Image batch">
				<h2 class={styles.heading}>Seedream 5.5 batch · {seedreamProviderNames[batch.provider]}</h2>
				<p>{batch.requests.length} requests · {batch.retryLimit} extra attempts per request</p>
				<p>
					{batch.reason ? stopReasons[batch.reason] : "Dispatch authorized until"}
					{#if !batch.reason}
						{@render date(batch.deadline)}
					{/if}
				</p>
				<p>
					Accepted initial estimate ·
					{batch.quote.status === "known" ? `${batch.quote.batch} credits` : "Unknown"}
				</p>
				{#if batch.reason}
					<p>
						{batch.counts.successful} successful · {batch.counts.failed} failed ·
						{batch.counts.rejected} rejected · {batch.counts.uncertain} uncertain ·
						{batch.counts.unsent} unsent · {batch.counts.pending} pending ·
						{batch.counts.paused} paused
					</p>
				{/if}
				{#if batch.wallet}
					<p>
						Account balance movement ·
						{#if batch.wallet.status === "observed"}
							{batch.wallet.delta} credits ({batch.wallet.before} at
							{@render date(batch.wallet.beforeAt)}, {batch.wallet.after} at
							{@render date(batch.wallet.afterAt)}). Top-ups, reservations and other account
							activity can affect this balance.
						{:else}
							Unavailable. {walletReasons[batch.wallet.reason]}
						{/if}
					</p>
				{/if}
				{#if batch.settlement}
					<p>
						{#if batch.settlement.credits === null}
							Total unknown
						{:else}
							{batch.settlement.complete ? "Confirmed total" : "Total unknown · known subtotal"} ·
							{batch.settlement.credits} credits · ${batch.settlement.usd} USD
						{/if}
					</p>
				{/if}
				{#each batch.requests as request (request.slot)}
					<section aria-label={`Request ${request.slot}`}>
						<h3>Request {request.slot} · {outcomeLabels[request.outcome]}</h3>
						<p>
							{request.used} of {1 + batch.retryLimit} attempts used{batch.reason &&
							request.used < 1 + batch.retryLimit
								? " · remaining attempts skipped"
								: ""}
						</p>
						{#each request.attempts as job (job.id)}
							{@render jobRow(job)}
						{/each}
					</section>
				{/each}
			</section>
		{/each}
		{#each data.jobs as job (job.id)}
			{@render jobRow(job)}
		{/each}
		{#if !data.jobs.length && !data.batches.length}
			<div class={styles.job}>
				<h2 class={styles.heading}>No jobs yet</h2>
				<p class={styles.note}>Queue a reviewed image or video to follow its progress here.</p>
				<div class={styles.actions}>
					<a class={styles.link} href="/image">Open Image Studio</a>
					<a class={styles.link} href="/video">Open Video Studio</a>
				</div>
			</div>
		{/if}
	</div>
</div>
