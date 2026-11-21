<script lang="ts">
import { reviewPriceReason } from "#lib/shared/image-studio/review-price.ts";
import { seedreamProviderNames } from "#lib/shared/image-studio/seedream.ts";
import { enhance, type SubmitFunction } from "$app/forms";
import { invalidate } from "$app/navigation";
import type { PageProps } from "./$types";
import { styles } from "./jobs-styles.ts";

let { data, form }: PageProps = $props();
let pending = $state<Record<string, "refresh" | "save" | undefined>>({});
const states = {
	submitting: "Submitting",
	unknown: "May have been submitted",
	rejected: "Submission rejected",
	waiting: "Waiting",
	running: "Running",
	completed: "Completed",
	failed: "Generation failed",
};
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
	let delay = Infinity;
	for (const job of jobs) {
		if (job.tracking === "automatic" || job.state === "submitting") delay = Math.min(delay, 2000);
		else if (job.nextReadAt && job.nextReadAt > now)
			delay = Math.min(delay, job.nextReadAt - now + 50);
	}
	if (!Number.isFinite(delay)) return;
	const timer = window.setTimeout(
		() => void invalidate("studio:jobs"),
		Math.min(delay, 2_147_483_647),
	);
	return () => window.clearTimeout(timer);
});

function submit(id: string, action: "refresh" | "save"): SubmitFunction {
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
		};
	};
}
</script>

<svelte:head><title>Jobs · Siluet</title></svelte:head>

{#snippet date(time: number)}
	<time datetime={new Date(time).toISOString()}>{clock.format(time)} UTC</time>
{/snippet}

<div class={styles.page}>
	<h1>Jobs</h1>
	<p class={styles.intro}>Track image requests and save completed images to Gallery.</p>
	<div class={styles.list}>
		{#each data.jobs as job (job.id)}
			{@const provider = seedreamProviderNames[job.provider]}
			{@const saved = data.saved.includes(job.id)}
			{@const cooldown = job.nextReadAt && job.nextReadAt > data.now ? job.nextReadAt : null}
			<article class={styles.job} aria-labelledby={`job-${job.id}-title`} id={`job-${job.id}`}>
				<header>
					<div class={styles.header}>
						<h2 class={styles.heading} id={`job-${job.id}-title`}>Seedream 5.5 · {provider}</h2>
						<span class={styles.state} data-state={job.state} aria-live="polite"
							>{states[job.state]}</span
						>
					</div>
					<p class={styles.meta}>Created {@render date(job.createdAt)}</p>
				</header>
				{#if job.message}
					<p class={styles.note}>
						{job.tracking === "paused" ? "Tracking paused. " : ""}{job.message}
					</p>
				{/if}
				{#if job.tracking === "manual"}
					<p class={styles.note}>
						Automatic tracking has ended. Refresh status to check the same task.
					</p>
				{/if}
				<dl class={styles.billing} aria-label="Billing">
					<div>
						<dt>Accepted estimate{job.provider === "toapis" ? " · standard route" : ""}</dt>
						<dd>
							{#if job.quote.status === "known"}
								{job.quote.perRequest} {provider} credits
								<span class={styles.meta}>(rates dated {job.quote.sourceDate.slice(0, 10)})</span>
							{:else}
								Unknown. {reviewPriceReason(job.quote)}
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
					{#if job.wallet}
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
				{#if !saved && job.state === "completed"}
					<p class={styles.note}>
						{#if job.expiresAt}
							Provider result expires {@render date(job.expiresAt)}.
						{:else}
							The provider keeps this result for a limited time. Save it promptly.
						{/if}
					</p>
				{/if}
				{#if cooldown && (job.canRefresh || job.tracking === "automatic")}
					<p class={styles.meta}>Next status check available {@render date(cooldown)}.</p>
				{/if}
				{#if saved || job.canSave || job.canRefresh || job.state === "unknown"}
					<div class={styles.actions}>
						{#if saved}
							<a class={styles.link} href={`/gallery/${encodeURIComponent(job.id)}`}
								>Open saved image</a
							>
						{:else if job.canSave}
							<form method="POST" action="?/save" use:enhance={submit(job.id, "save")}>
								<input type="hidden" name="id" value={job.id}>
								<button
									class={styles.button}
									disabled={!!pending[job.id] || cooldown !== null}
									type="submit"
								>
									{pending[job.id] === "save" ? "Saving…" : "Save to Gallery"}
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
						{#if job.state === "unknown"}
							<a class={styles.link} href="/image">Review a new request</a>
						{/if}
					</div>
				{/if}
				{#if form && form.id === job.id && form.message}
					<p role="status" class={styles.note}>{form.message}</p>
				{/if}
			</article>
		{:else}
			<div class={styles.job}>
				<h2 class={styles.heading}>No jobs yet</h2>
				<p class={styles.note}>
					Queue a reviewed request in Image Studio to follow its progress here.
				</p>
				<a class={styles.link} href="/image">Open Image Studio</a>
			</div>
		{/each}
	</div>
</div>
