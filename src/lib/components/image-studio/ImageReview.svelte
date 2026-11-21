<script lang="ts">
import { Tabs } from "@ark-ui/svelte/tabs";
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
import type { PricingFeeds, PricingProvider } from "#lib/shared/pricing/feeds.ts";

let {
	review,
	feeds,
	nowMs,
	provider = undefined,
	operation = "generate",
	headingId = "studio-review-title",
}: {
	review: ImageReviewData | null;
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
const quote = $derived(
	review && estimateReviewPrice(feeds, review.pricing, batch, browserNow ?? nowMs),
);
const expiry = $derived(reviewPriceExpiry(quote ?? undefined));

$effect(() => {
	const watch = watchReviewExpiry(expiry, (time) => {
		browserNow = time;
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
	<p class="note">
		{selectedProvider === "toapis" ? "Feed collected" : "Rates dated"}
		<time datetime={sourceDate}>{sourceDate.slice(0, 10)}</time>
		{#if selectedProvider === "toapis"}
			· Expires <time datetime={expiresAt}>{expiresAt.slice(0, 10)}</time>
		{/if}
	</p>
{/snippet}

<section class="review" aria-labelledby={headingId}>
	<h2 id={headingId} tabindex="-1">Review request</h2>
	<Tabs.Root defaultValue="review" activationMode="automatic" loopFocus ids={{ content: panelId }}>
		<Tabs.List class="review-tabs" aria-labelledby={headingId}>
			{#each tabs as tab (tab.value)}
				<Tabs.Trigger value={tab.value} aria-controls={panelId(tab.value)}
					>{tab.label}</Tabs.Trigger
				>
			{/each}
		</Tabs.List>

		<Tabs.Content value="review" class="review-panel">
			<dl class="facts">
				<div>
					<dt>API provider</dt>
					<dd>{providerName ?? "None connected"}</dd>
				</div>
				<div>
					<dt>Operation</dt>
					<dd>{isEdit ? "Reference-guided image edit" : "Text to image"}</dd>
				</div>
				<div>
					<dt>Media on submission</dt>
					<dd>
						{#if review?.sources.length}
							<ol>
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
				<div>
					<dt>Price</dt>
					<dd data-studio-price aria-live="polite">
						{#if selectedProvider === "toapis"}
							<span class="note">Standard-route pricing</span>
						{/if}
						{#if quote?.status === "known"}
							<p>Estimated {quote.perRequest} {providerName} credits per request</p>
							<p>Estimated {quote.batch} {providerName} credits for the initial batch</p>
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

		<Tabs.Content value="batch" class="review-panel">
			<div class="batch">
				<label>
					Batch count
					<select bind:value={count}>
						{#each reviewBatchCounts as requests (requests)}
							<option value={requests}>{requests} {requests === 1 ? "request" : "requests"}</option>
						{/each}
					</select>
				</label>
				<label>
					Additional attempts per request
					<select bind:value={retryLimit}>
						{#each reviewRetryLimits as retries (retries)}
							<option value={retries}>{retries}</option>
						{/each}
					</select>
				</label>
			</div>
			<p class="note">Each request runs independently. Initial batch estimates exclude retries.</p>
		</Tabs.Content>

		<Tabs.Content value="outgoing" class="review-panel">
			{#if review}
				<div class="wire">
					<p><code>{review.outgoing.method} {review.outgoing.url}</code></p>
					<p><code>Authorization: Bearer [API key hidden]</code></p>
					<!-- svelte-ignore a11y_no_noninteractive_tabindex (Keyboard users must be able to scroll the JSON.) -->
					<!-- biome-ignore lint/a11y/noNoninteractiveTabindex: Keyboard access to the scrollable JSON. -->
					<section class="wire-json" tabindex="0" aria-label="JSON request body">
						<pre><code>{JSON.stringify(review.outgoing.body, null, 2)}</code></pre>
					</section>
				</div>
			{:else}
				<p class="note">
					{selectedProvider
						? "Complete the request to preview its JSON."
						: "Connect an API provider to preview this request."}
				</p>
			{/if}
		</Tabs.Content>
	</Tabs.Root>

	{#if selectedProvider === "toapis"}
		<p class="note">
			ToAPIs may use a fallback for eligible accounts and regions. Fallback pricing is unknown.
		</p>
	{/if}
	<div class="actions">
		<button
			type="button"
			disabled
			aria-describedby={`${headingId}-exposure ${headingId}-availability`}
		>
			Queue {count} {count === 1 ? "request" : "requests"}
		</button>
		<p id={`${headingId}-exposure`} class="exposure" aria-live="polite">
			Up to {maxAttempts} potentially billable {maxAttempts === 1 ? "submission" : "submissions"}.
		</p>
	</div>
	<p id={`${headingId}-availability`} class="note">Queue is unavailable in offline review.</p>
</section>

<style>
.review {
	display: grid;
	gap: 0.85rem;
	min-width: 0;
	padding: clamp(1rem, 2.25vw, 1.5rem);
	border: 1px solid var(--line);
	border-radius: 15px;
	background: var(--surface);
}
h2 {
	font:
		680 1.18rem / 1.2 system-ui,
		sans-serif;
	letter-spacing: -0.02em;
	scroll-margin-block-start: 0.85rem;
}
.review :global(.review-tabs) {
	display: flex;
	border-block-end: 1px solid var(--line);
}
.review :global(.review-tabs > button) {
	min-height: 44px;
	padding: 0.45rem 0.65rem;
	border: 0;
	border-radius: 0;
	border-block-end: 2px solid transparent;
	background: transparent;
	color: var(--muted);
	font-size: 0.87rem;
	line-height: 1.25;
}
.review :global(.review-tabs > button:hover),
.review :global(.review-tabs > button[aria-selected="true"]) {
	color: var(--accent);
}
.review :global(.review-tabs > button[aria-selected="true"]) {
	border-block-end-color: currentColor;
}
.review :global(.review-tabs > button:focus-visible) {
	outline-offset: -4px;
}
.review :global(.review-panel) {
	min-width: 0;
	margin-block-start: 0.85rem;
	font-size: 0.875rem;
}
.facts {
	display: grid;
	gap: 0.45rem;
	margin: 0;
}
.facts > div {
	display: grid;
	grid-template-columns: minmax(4.5rem, 6rem) minmax(0, 1fr);
	gap: 0.5rem;
}
dt {
	color: var(--muted);
}
dd {
	margin: 0;
	overflow-wrap: anywhere;
}
ol {
	margin: 0;
	padding-inline-start: 1.15rem;
}
li + li {
	margin-block-start: 0.25rem;
}
.note {
	color: var(--muted);
	font-size: 0.85rem;
}
.batch {
	display: flex;
	flex-wrap: wrap;
	gap: 0.75rem;
	margin-block-end: 0.6rem;
}
.batch label {
	display: grid;
	gap: 0.3rem;
}
.batch select {
	min-height: 44px;
}
.wire {
	padding: 0.65rem 0.75rem;
	border-radius: 8px;
	background: var(--canvas);
	overflow-wrap: anywhere;
}
.wire-json {
	max-block-size: 14rem;
	margin: 0.45rem 0 0;
	overflow: auto;
}
pre {
	margin: 0;
	white-space: pre-wrap;
}
.actions {
	display: flex;
	flex-wrap: wrap;
	align-items: center;
	gap: 0.4rem 0.85rem;
}
.actions button {
	min-height: 44px;
	border-color: var(--line);
	background: var(--canvas);
	color: var(--muted);
	cursor: not-allowed;
}
.exposure {
	font-size: 0.85rem;
	font-weight: 650;
}
</style>
