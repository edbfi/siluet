<script lang="ts">
import { Tabs } from "@ark-ui/svelte/tabs";
import { onDestroy, tick } from "svelte";
import type { ImageReviewData, ReviewOperation } from "#lib/shared/image-studio/review.ts";
import {
	estimateReviewPrice,
	maximumReviewAttempts,
	reviewBatchCounts,
	reviewPriceExpiry,
	reviewPriceReason,
	reviewRetryLimits,
	watchReviewExpiry,
} from "#lib/shared/image-studio/review-price.ts";
import type { SeedreamDraft } from "#lib/shared/image-studio/seedream.ts";
import type { PriceEstimate } from "#lib/shared/pricing/estimate.ts";
import type { PricingFeeds, PricingProvider } from "#lib/shared/pricing/feeds.ts";
import { goto } from "$app/navigation";
import * as styles from "./image-review-styles.ts";

let {
	review,
	draft,
	feeds,
	nowMs,
	provider = undefined,
	operation = "generate",
	headingId = "studio-review-title",
}: {
	review: ImageReviewData | null;
	draft: SeedreamDraft;
	feeds: PricingFeeds;
	nowMs: number;
	provider?: PricingProvider;
	operation?: ReviewOperation;
	headingId?: string;
} = $props();

const providerNames = { poyo: "Poyo.ai", toapis: "ToAPIs" };
const tabs = [
	{ value: "review", label: "Review" },
	{ value: "batch", label: "Batch" },
	{ value: "outgoing", label: "Outgoing request" },
];
const panelId = (value: string) => `${headingId}-${value}`;
let count = $state(1);
let retryLimit = $state(0);
let browserNow = $state<number>();
const batch = $derived({ count, retryLimit });
const maxAttempts = $derived(maximumReviewAttempts(batch));
const selectedProvider = $derived(review?.pricing.provider ?? provider);
const providerName = $derived(selectedProvider && providerNames[selectedProvider]);
const isEdit = $derived((review?.pricing.operation ?? operation) === "edit");
type QueueInput = { draft: SeedreamDraft; count: number; retryLimit: number };
type ReviewTerms = { token: string; quote: PriceEstimate; requiresConsent: boolean };
const supported = $derived(!isEdit && count === 1 && retryLimit === 0);
const request = $derived(
	review && supported ? { draft: $state.snapshot(draft), count, retryLimit } : null,
);
let authorized = $state.raw<{ request: QueueInput; terms: ReviewTerms } | null>(null);
let pending = $state<"review" | "queue" | null>(null);
let acceptedToken = $state<string | null>(null);
let feedback = $state.raw<{ request: QueueInput; message: string } | null>(null);
let tabValue = $state("review");
let mounted = true;
onDestroy(() => {
	mounted = false;
});
const terms = $derived(authorized?.request === request ? authorized.terms : null);
const offlineQuote = $derived(
	review && estimateReviewPrice(feeds, review.pricing, batch, browserNow ?? nowMs),
);
const expiry = $derived(reviewPriceExpiry(terms?.quote ?? offlineQuote ?? undefined));
const expired = $derived(expiry !== undefined && (browserNow ?? nowMs) >= expiry);
const current = $derived(!expired ? terms : null);
const quote = $derived(current?.quote ?? offlineQuote);
const canQueue = $derived(current && (!current.requiresConsent || acceptedToken === current.token));

$effect(() => {
	if (authorized && authorized.request !== request) {
		authorized = null;
		acceptedToken = null;
	}
	if (feedback && feedback.request !== request) feedback = null;
});

function post(path: string, body: object) {
	return fetch(path, {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify(body),
	});
}

async function inspect() {
	const input = request;
	if (!input || pending) return;
	pending = "review";
	acceptedToken = null;
	authorized = null;
	feedback = null;
	tabValue = "review";
	try {
		const response = await post("/image/review", { ...input, acceptUnknown: false });
		if (!response.ok) throw new Error();
		const terms: ReviewTerms = await response.json();
		if (mounted && input === request) {
			const focusHeading =
				document.activeElement?.id === `${headingId}-inspect` ||
				document.activeElement === document.body;
			authorized = { request: input, terms };
			if (focusHeading) {
				await tick();
				document.getElementById(headingId)?.focus({ preventScroll: true });
			}
		}
	} catch {
		feedback = {
			request: input,
			message: "Review is unavailable. Check the provider connection and try again.",
		};
	} finally {
		pending = null;
	}
}

async function queue() {
	const input = request;
	if (!input || !current || !canQueue || pending || tabValue !== "review") return;
	pending = "queue";
	feedback = null;
	try {
		const response = await post("/image/queue", {
			...input,
			token: current.token,
			acceptUnknown: acceptedToken === current.token,
		});
		if (response.status === 409 || response.status === 400) {
			const { review: fresh } = await response.json();
			if (!mounted || input !== request) return;
			authorized = fresh ? { request: input, terms: fresh } : null;
			acceptedToken = null;
			feedback = {
				request: input,
				message: fresh
					? "The terms changed. Check the updated Review before queuing."
					: "Review is unavailable for these terms. Check the provider connection and review again.",
			};
			return;
		}
		if (!response.ok) throw new Error();
		const { jobId } = await response.json();
		if (typeof jobId !== "string" || !jobId) throw new Error();
		if (mounted) await goto(`/jobs#job-${encodeURIComponent(jobId)}`);
	} catch {
		feedback = {
			request: input,
			message: "Queue confirmation is unavailable. Check Jobs before starting another request.",
		};
	} finally {
		pending = null;
	}
}

$effect(() => {
	const reviewed = terms;
	const input = request;
	const expiresAt = expiry;
	const watch = watchReviewExpiry(expiresAt, (time) => {
		browserNow = time;
		if (reviewed && input && expiresAt !== undefined && time >= expiresAt) {
			authorized = null;
			acceptedToken = null;
			feedback = {
				request: input,
				message: "The reviewed rates expired. Review the request again before queuing.",
			};
		}
	});
	window.addEventListener("focus", watch.refresh);
	document.addEventListener("visibilitychange", watch.refresh);
	return () => {
		watch.stop();
		window.removeEventListener("focus", watch.refresh);
		document.removeEventListener("visibilitychange", watch.refresh);
	};
});
</script>

{#snippet rateDates(sourceDate: string, expiresAt: string)}
	<p class={styles.note}>
		{selectedProvider === "toapis" ? "Feed collected" : "Rates dated"}
		<time datetime={sourceDate}>{sourceDate.slice(0, 10)}</time>
		· Expires
		<time datetime={expiresAt}
			>{current
				? `${new Date(expiresAt).toISOString().slice(0, 19).replace("T", " ")} UTC`
				: expiresAt.slice(0, 10)}</time
		>
	</p>
{/snippet}

<section class={styles.panel} aria-labelledby={headingId}>
	<h2 class={styles.heading} id={headingId} tabindex="-1">Review request</h2>
	<Tabs.Root
		value={tabValue}
		onValueChange={({ value }) => (tabValue = value)}
		activationMode="automatic"
		loopFocus
		ids={{ content: panelId }}
	>
		<Tabs.List class={styles.tabList} aria-labelledby={headingId}>
			{#each tabs as tab (tab.value)}
				<Tabs.Trigger class={styles.tab} value={tab.value} aria-controls={panelId(tab.value)}
					>{tab.label}</Tabs.Trigger
				>
			{/each}
		</Tabs.List>

		<Tabs.Content value="review" class={styles.tabContent}>
			<dl class={styles.facts}>
				<div class={styles.fact}>
					<dt class={styles.term}>API provider</dt>
					<dd class={styles.detail}>{providerName ?? "None connected"}</dd>
				</div>
				<div class={styles.fact}>
					<dt class={styles.term}>Operation</dt>
					<dd class={styles.detail}>{isEdit ? "Reference-guided image edit" : "Text to image"}</dd>
				</div>
				<div class={styles.fact}>
					<dt class={styles.term}>Media on submission</dt>
					<dd class={styles.detail}>
						{#if review?.sources.length}
							<ol class={styles.mediaList}>
								{#each review.sources as source}
									<li>
										{source.label}{source.kind === "url"
											? " (provider fetches the full URL)"
											: " (file upload)"}
									</li>
								{/each}
							</ol>
						{:else if isEdit}
							Complete the request to review the media.
						{:else}
							None
						{/if}
					</dd>
				</div>
				<div class={styles.fact}>
					<dt class={styles.term}>Price</dt>
					<dd class={styles.detail} data-studio-price aria-live="polite">
						{#if selectedProvider === "toapis"}
							<span class={styles.note}>Standard-route pricing</span>
						{/if}
						{#if quote?.status === "known"}
							<p>Estimated {quote.perRequest} {providerName} credits per request</p>
							{#if current && quote.unit === "toapis_credit"}
								<p>Standard-route estimate ${quote.usd.perRequest} USD.</p>
							{:else if !current}
								<p>Estimated {quote.batch} {providerName} credits for the initial batch</p>
							{/if}
							{@render rateDates(quote.sourceDate, quote.expiresAt)}
						{:else if quote?.status === "unknown"}
							<p>Unknown. {reviewPriceReason(quote)}</p>
							{#if quote.advertisedUnitRate}
								{@const rate = quote.advertisedUnitRate}
								<p>
									About {rate.approximateCredits} {providerName} credits per million total tokens
								</p>
								{@render rateDates(rate.sourceDate, rate.expiresAt)}
							{/if}
						{:else}
							<p>Unknown. Complete the request to see an estimate.</p>
						{/if}
					</dd>
				</div>
			</dl>
		</Tabs.Content>

		<Tabs.Content value="batch" class={styles.tabContent}>
			<div class={styles.batch}>
				<label class={styles.batchLabel}>
					Batch count
					<select class={styles.batchSelect} bind:value={count}>
						{#each reviewBatchCounts as requests (requests)}
							<option value={requests}>{requests} {requests === 1 ? "request" : "requests"}</option>
						{/each}
					</select>
				</label>
				<label class={styles.batchLabel}>
					Additional attempts per request
					<select class={styles.batchSelect} bind:value={retryLimit}>
						{#each reviewRetryLimits as retries (retries)}
							<option value={retries}>{retries}</option>
						{/each}
					</select>
				</label>
			</div>
			<p class={styles.note}>
				Each request runs independently. Initial batch estimates exclude retries.
			</p>
		</Tabs.Content>

		<Tabs.Content value="outgoing" class={styles.tabContent}>
			{#if review}
				<div class={styles.wire}>
					<p><code>{review.outgoing.method} {review.outgoing.url}</code></p>
					<p><code>Authorization: Bearer [API key hidden]</code></p>
					<!-- svelte-ignore a11y_no_noninteractive_tabindex (Keyboard users must be able to scroll the JSON.) -->
					<!-- biome-ignore lint/a11y/noNoninteractiveTabindex: Keyboard access to the scrollable JSON. -->
					<section class={styles.jsonScroller} tabindex="0" aria-label="JSON request body">
						<pre
							class={styles.json}
						><code>{JSON.stringify(review.outgoing.body, null, 2)}</code></pre>
					</section>
				</div>
			{:else}
				<p class={styles.note}>
					{selectedProvider
						? "Complete the request to preview its JSON."
						: "Connect an API provider to preview this request."}
				</p>
			{/if}
		</Tabs.Content>
	</Tabs.Root>

	{#if selectedProvider === "toapis"}
		<p class={styles.note}>
			ToAPIs may use a fallback for eligible accounts and regions. Fallback pricing is unknown.
		</p>
	{/if}
	{#if current?.requiresConsent && tabValue === "review"}
		<label class={styles.consent} for={`${headingId}-consent`}>
			<input
				id={`${headingId}-consent`}
				type="checkbox"
				checked={acceptedToken === current.token}
				onchange={(event) =>
					(acceptedToken = event.currentTarget.checked ? (current?.token ?? null) : null)}
			>
			{selectedProvider !== "toapis"
				? "I accept the unknown cost of this request."
				: current.quote.status === "known"
					? "I accept the unknown cost if ToAPIs uses a fallback."
					: "I accept the unknown cost on the standard route or a fallback."}
		</label>
	{/if}
	<div class={styles.actions}>
		{#if supported && !current}
			<button
				type="button"
				id={`${headingId}-inspect`}
				class={styles.queue}
				disabled={!request || !!pending}
				onclick={inspect}
			>
				{pending === "review" ? "Reviewing…" : "Review request"}
			</button>
		{/if}
		<button
			class={styles.queue}
			type="button"
			disabled={!canQueue || !!pending || tabValue !== "review"}
			onclick={queue}
			aria-describedby={`${headingId}-exposure ${headingId}-availability`}
		>
			{pending === "queue" ? "Queuing…" : `Queue ${count} ${count === 1 ? "request" : "requests"}`}
		</button>
		<p id={`${headingId}-exposure`} class={styles.exposure} aria-live="polite">
			Up to {maxAttempts} potentially billable {maxAttempts === 1 ? "submission" : "submissions"}.
		</p>
	</div>
	<p id={`${headingId}-availability`} class={styles.note} role="status">
		{#if feedback && feedback.request === request}
			{feedback.message}
		{:else if !supported}
			Queue supports text to image with one request and zero additional attempts.
		{:else if current && tabValue !== "review"}
			Open the Review tab to queue this request.
		{:else if current}
			{canQueue ? "Ready to queue." : "Confirm the unknown cost before queuing."}
		{:else}
			Review the completed request to confirm its current terms.
		{/if}
	</p>
</section>
