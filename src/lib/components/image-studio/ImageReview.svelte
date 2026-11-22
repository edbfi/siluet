<script lang="ts">
import { Tabs } from "@ark-ui/svelte/tabs";
import { onDestroy, tick } from "svelte";
import { maxSeedreamReferences } from "#lib/shared/image-studio/references.ts";
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
import { type ZImageDraft, zImageDisclosure } from "#lib/shared/image-studio/z-image.ts";
import {
	queueEvidenceProblem,
	type ReleasedImageOperation,
	zImageModel,
} from "#lib/shared/media-catalog/registry.ts";
import { sumAmounts } from "#lib/shared/pricing/decimal.ts";
import type { PriceEstimate } from "#lib/shared/pricing/estimate.ts";
import type { PricingFeeds, PricingProvider } from "#lib/shared/pricing/feeds.ts";
import { goto } from "$app/navigation";
import ImageReferenceGuidance from "./ImageReferenceGuidance.svelte";
import * as styles from "./image-review-styles.ts";

let {
	modelId,
	connected,
	entry,
	review,
	draft,
	referenceLabels,
	duplicateWarning,
	feeds,
	nowMs,
	provider = undefined,
	operation = "generate",
	headingId = "studio-review-title",
}: {
	modelId: string;
	connected: boolean;
	entry: ReleasedImageOperation | null;
	review: ImageReviewData | null;
	draft: SeedreamDraft | ZImageDraft;
	referenceLabels: readonly string[];
	duplicateWarning: string | null;
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
type QueueInput = {
	operationKey: ReleasedImageOperation["key"];
	draft: SeedreamDraft | ZImageDraft;
	count: number;
	retryLimit: number;
};
type ReviewTerms = {
	token: string;
	quote: PriceEstimate;
	requiresConsent: boolean;
	editDisclosure?: readonly string[];
	disclosure?: readonly string[];
};
const unavailable = $derived.by(() => {
	if (!connected && modelId === zImageModel.id) return "Connect Poyo.ai in Settings to queue.";
	const evidenceProblem = entry && queueEvidenceProblem(entry.evidence);
	if (evidenceProblem) return evidenceProblem;
	if (isEdit && duplicateWarning) return duplicateWarning;
	if (modelId === zImageModel.id && (count !== 1 || retryLimit !== 0))
		return "Z-Image Queue supports one request and zero additional attempts.";
	if (modelId === zImageModel.id && isEdit && draft.references.length !== 1)
		return "Add one public image URL to review this edit.";
	if (
		isEdit &&
		(draft.references.length < 1 ||
			draft.references.length > maxSeedreamReferences ||
			draft.references.some((reference) => reference.kind !== "url"))
	) {
		return `Queue requires 1–${maxSeedreamReferences} public image URLs. Files can be staged for offline Review.`;
	}
	return null;
});
const request = $derived(
	review && entry && !unavailable
		? { operationKey: entry.key, draft: $state.snapshot(draft), count, retryLimit }
		: null,
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
const disclosure = $derived(
	modelId === zImageModel.id
		? (current?.disclosure ?? zImageDisclosure(operation))
		: current?.editDisclosure,
);
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

function applyTerms(input: QueueInput, terms: ReviewTerms) {
	const zImage = input.operationKey.model === zImageModel.id;
	const disclosure = zImage ? terms.disclosure : terms.editDisclosure;
	if (
		(zImage || input.draft.operation === "edit") &&
		(!Array.isArray(disclosure) ||
			disclosure.length === 0 ||
			!disclosure.every((line) => typeof line === "string" && line.trim()))
	) {
		authorized = null;
		feedback = {
			request: input,
			message: "Provider disclosure is unavailable. Review again before queuing.",
		};
		return false;
	}
	authorized = { request: input, terms };
	return true;
}

async function focusReview(trigger: "inspect" | "queue") {
	if (
		document.activeElement?.id === `${headingId}-${trigger}` ||
		document.activeElement === document.body
	) {
		await tick();
		document.getElementById(headingId)?.focus();
	}
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
		if (mounted && input === request && applyTerms(input, terms)) await focusReview("inspect");
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
			const result: { review?: ReviewTerms; until?: number } | null = await response
				.json()
				.catch(() => null);
			if (!mounted || input !== request) return;
			const fresh = result?.review;
			authorized = null;
			acceptedToken = null;
			if (!fresh || applyTerms(input, fresh)) {
				feedback = {
					request: input,
					message: result?.until
						? `The provider is cooling down. Review and click Queue again after ${new Date(result.until).toISOString()}.`
						: fresh
							? "The terms changed. Check the updated Review before queuing."
							: "Review is unavailable for these terms. Check the provider connection and review again.",
				};
			}
			tabValue = "review";
			await focusReview("queue");
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
				{#if entry && connected}
					<div class={styles.fact}>
						<dt class={styles.term}>Route evidence</dt>
						<dd class={styles.detail}>
							{entry.key.provider === "poyo"
								? "The balance check accepted this key. Access to this model is unconfirmed."
								: "The global image model list included this model for this key."}
							{#if !queueEvidenceProblem(entry.evidence)}
								The model contract declares
								<code
									>{entry.key.provider === "poyo" ? "input.enable_safety_checker" : "disable_nsfw"}:
									false</code
								>.
							{/if}
						</dd>
					</div>
				{/if}
				<div class={styles.fact}>
					<dt class={styles.term}>Operation</dt>
					<dd class={styles.detail}>{isEdit ? "Reference-guided image edit" : "Text to image"}</dd>
				</div>
				<div class={styles.fact}>
					<dt class={styles.term}>{isEdit ? "Reference images" : "Media on submission"}</dt>
					<dd class={styles.detail}>
						{#if review?.sources.length}
							<!-- biome-ignore lint/a11y/noRedundantRoles: Safari needs an explicit role when list markers are hidden. -->
							<ol class={styles.mediaList} role="list">
								{#each review.sources as source, index}
									<li>
										{#if modelId !== zImageModel.id}
											{index + 1}. Reference {referenceLabels[index]} ·
										{/if}
										{source.label}{source.kind === "url" ? " (URL reference)" : " (local file)"}
									</li>
								{/each}
							</ol>
						{:else if isEdit}
							Complete the request to review the media.
						{:else}
							None
						{/if}
						{#if isEdit && selectedProvider && "aspectRatio" in draft.options}
							<ImageReferenceGuidance
								provider={selectedProvider}
								autoFraming={draft.references.length > 1 && draft.options.aspectRatio === "auto"}
							/>
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
							{#if quote.unit === "toapis_credit"}
								<p>Standard-route estimate ${quote.usd.perRequest} USD.</p>
							{/if}
							{#if !current || count > 1 || retryLimit > 0}
								<p>Estimated {quote.batch} {providerName} credits for the initial batch</p>
							{/if}
							{#if count > 1 || retryLimit > 0}
								<p>
									Estimated {sumAmounts([quote.perRequest], maxAttempts)} {providerName} credits if
									all {maxAttempts} submissions are charged at this rate.
								</p>
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
			{#if modelId !== zImageModel.id && (count > 1 || retryLimit > 0)}
				<p class={styles.note}>
					{count} requests · {retryLimit} extra attempts per request · up to
					{maxAttempts} potentially charged submissions. Queue authorizes these retries. Each
					attempt sends the same prompt, options{isEdit ? " and full ordered reference URLs" : ""}
					and can incur a new charge. Dispatch can continue for two minutes if you leave this page.
				</p>
				<p class={styles.note}>
					{selectedProvider === "toapis"
						? "Maximum spend including fallback is unknown."
						: "The provider does not enforce the estimated spend as a cap."}
				</p>
			{/if}
			{#if disclosure}
				<h3 class={styles.disclosureHeading} id={`${headingId}-disclosure`}>Provider disclosure</h3>
				<ul class={styles.disclosure} aria-labelledby={`${headingId}-disclosure`}>
					{#each disclosure as line, index (index)}
						<li>{line}</li>
					{/each}
				</ul>
			{/if}
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
				{modelId === zImageModel.id
					? "Z-Image batches are available for offline estimates. Queue supports one request with zero retries."
					: "Each request runs independently. Initial batch estimates exclude retries."}
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
			{count > 1 || retryLimit > 0
				? "I accept unknown costs for this batch, including authorized retries and any applicable fallback."
				: selectedProvider !== "toapis"
					? "I accept the unknown cost of this request."
					: current.quote.status === "known"
						? "I accept the unknown cost if ToAPIs uses a fallback."
						: "I accept the unknown cost on the standard route or a fallback."}
		</label>
	{/if}
	<div class={styles.actions}>
		{#if !unavailable && !current}
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
			id={`${headingId}-queue`}
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
		{:else if unavailable}
			{unavailable}
		{:else if current && tabValue !== "review"}
			Open the Review tab to queue this request.
		{:else if current}
			{canQueue ? "Ready to queue." : "Confirm the unknown cost before queuing."}
		{:else}
			Review the completed request to confirm its current terms.
		{/if}
	</p>
</section>
