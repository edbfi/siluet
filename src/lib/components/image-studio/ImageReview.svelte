<script lang="ts">
import { Tabs } from "@ark-ui/svelte/tabs";
import { onDestroy, tick } from "svelte";
import type { DerivedDraft } from "#lib/shared/image-studio/derived.ts";
import {
	type DerivedWording,
	derivedQuote,
	derivedWording,
	refusalNote,
} from "#lib/shared/image-studio/derived-review.ts";
import {
	fileByteLimit,
	fileLimitMessage,
	fileUploadRoutes,
	neutralFilename,
	type StageDescriptor,
} from "#lib/shared/image-studio/file-edit.ts";
import { maxSeedreamReferences } from "#lib/shared/image-studio/references.ts";
import type { ImageReviewData, ReviewOperation } from "#lib/shared/image-studio/review.ts";
import { imageReviewFiltering } from "#lib/shared/image-studio/review-filtering.ts";
import {
	estimateReviewPrice,
	maximumReviewAttempts,
	reviewBatchCounts,
	reviewPriceExpiry,
	reviewPriceReason,
	reviewReferenceCharge,
	reviewRetryLimits,
	watchReviewExpiry,
} from "#lib/shared/image-studio/review-price.ts";
import type { SeedreamDraft } from "#lib/shared/image-studio/seedream.ts";
import { type ZImageDraft, zImageDisclosure } from "#lib/shared/image-studio/z-image.ts";
import type { FilteringEvidence } from "#lib/shared/media-catalog/filtering.ts";
import type { QueueKey, QueueRow } from "#lib/shared/media-catalog/queue-row.ts";
import { type ReleasedImageOperation, zImageModel } from "#lib/shared/media-catalog/registry.ts";
import { sumAmounts } from "#lib/shared/pricing/decimal.ts";
import type { PriceEstimate } from "#lib/shared/pricing/estimate.ts";
import type { PricingFeeds, PricingProvider } from "#lib/shared/pricing/feeds.ts";
import { goto } from "$app/navigation";
import ImageReferenceGuidance from "./ImageReferenceGuidance.svelte";
import * as styles from "./image-review-styles.ts";
import LocalCopyDetails from "./LocalCopyDetails.svelte";
import type { LocalCopies } from "./local-copy.svelte.ts";

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
	localCopies = undefined,
	catalogRow = null,
	refusedAt = null,
	pending = $bindable(null),
}: {
	modelId: string;
	connected: boolean;
	/** The exact operation and its D4 evidence: a released operation or a derived row's. */
	entry: { key: ReleasedImageOperation["key"] | QueueKey; evidence: FilteringEvidence } | null;
	review: ImageReviewData | null;
	draft: SeedreamDraft | ZImageDraft | DerivedDraft;
	referenceLabels: readonly string[];
	duplicateWarning: string | null;
	feeds: PricingFeeds;
	nowMs: number;
	provider?: PricingProvider;
	operation?: ReviewOperation;
	headingId?: string;
	/** The staged copies of the attached JPEG and PNG files, which Review and Queue send in order. */
	localCopies?: LocalCopies;
	/** A Queue-eligible derived row. */
	catalogRow?: QueueRow | null;
	/** The date Poyo.ai refused this model for this key, if it did. It never blocks Queue. */
	refusedAt?: number | null;
	/** The Review or Queue in flight. */
	pending?: "review" | "queue" | null;
} = $props();
// What a derived Review states and binds, shown offline before any Review request.
const bound = $derived(catalogRow ? derivedWording(catalogRow) : null);
const references = $derived("references" in draft ? draft.references : []);

const providerNames = { poyo: "Poyo.ai", toapis: "ToAPIs" };
const tabs = [
	{ value: "review", label: "Review" },
	{ value: "batch", label: "Batch" },
	{ value: "outgoing", label: "Outgoing request" },
];
const panelId = (value: string) => `${headingId}-${value}`;
// The Batch tab's choices. A derived row queues one request with zero retries, so they never
// follow the creator from a Seedream batch to it.
let batchCount = $state(1);
let batchRetries = $state(0);
const count = $derived(catalogRow ? 1 : batchCount);
const retryLimit = $derived(catalogRow ? 0 : batchRetries);
let browserNow = $state<number>();
const batch = $derived({ count, retryLimit });
const maxAttempts = $derived(maximumReviewAttempts(batch));
const selectedProvider = $derived(review?.pricing.provider ?? provider);
const providerName = $derived(selectedProvider && providerNames[selectedProvider]);
const isEdit = $derived((review?.pricing.operation ?? operation) === "edit");
type FileReference = { kind: "url"; url: string } | { kind: "file"; stage: StageDescriptor };
type QueueInput = {
	operationKey: ReleasedImageOperation["key"] | QueueKey;
	draft: SeedreamDraft | ZImageDraft | FileDraft | DerivedDraft;
	count: number;
	retryLimit: number;
	/** The staged files a file edit reviews, in reference order. */
	files?: { position: number; stage: StageDescriptor }[];
};
type FileDraft = Omit<SeedreamDraft, "references"> & { references: FileReference[] };
type ReviewedFile = { position: number; stage: StageDescriptor };
// Set only for attached JPEG and PNG files in a Seedream edit, in reference order.
const localFiles = $derived(
	modelId !== zImageModel.id && isEdit && localCopies?.files.length ? localCopies.files : null,
);
const fileStages = $derived(
	localFiles?.every(({ copy }) => copy.stage)
		? localFiles.map(({ position, copy }) => ({
				position,
				stage: copy.stage as StageDescriptor,
			}))
		: null,
);
const fileCount = $derived(localFiles?.length ?? 0);
type ReviewTerms = {
	files?: ReviewedFile[];
	token: string;
	quote: PriceEstimate;
	requiresConsent: boolean;
	editDisclosure?: readonly string[];
	disclosure?: readonly string[];
	/** What a derived Review bound. */
	wording?: DerivedWording;
};
// A derived Review binds its D4 wording, so an open-absent row can queue with its disclosure.
const filtering = $derived(
	entry && imageReviewFiltering(entry.evidence, entry.key.provider, bound?.d4),
);
const unavailable = $derived.by(() => {
	if (!connected && (modelId === zImageModel.id || catalogRow))
		return "Connect Poyo.ai in Settings to queue.";
	if (filtering?.unavailable) return filtering.unavailable;
	if (isEdit && duplicateWarning) return duplicateWarning;
	if (localFiles) {
		if (!connected) return "Connect Poyo.ai or ToAPIs in Settings to queue.";
		if (count !== 1 || retryLimit !== 0)
			return "Local-file Queue supports one request and zero additional attempts.";
		if (fileStages) return null;
		const waiting = localFiles.find(({ copy }) => !copy.stage);
		const status = waiting?.copy.status;
		if (fileCount === 1) return status || "Preparing the attached file…";
		return status ? `Reference ${waiting.position}: ${status}` : "Preparing the attached files…";
	}
	if (modelId === zImageModel.id && (count !== 1 || retryLimit !== 0))
		return "Z-Image Queue supports one request and zero additional attempts.";
	if (modelId === zImageModel.id && isEdit && references.length !== 1)
		return "Add one public image URL to review this edit.";
	if (
		isEdit &&
		(references.length < 1 ||
			references.length > maxSeedreamReferences ||
			references.some((reference) => reference.kind !== "url"))
	) {
		return `Queue requires 1–${maxSeedreamReferences} public image URLs or local JPEG and PNG files. Other formats stay available for offline Review.`;
	}
	return null;
});
const request = $derived.by((): QueueInput | null => {
	if (!review || !entry || unavailable) return null;
	// Typed through object: a derived draft's recursive option values defeat Snapshot's inference.
	const snapshot = $state.snapshot(draft as object) as QueueInput["draft"];
	if (!fileStages || modelId === zImageModel.id)
		return { operationKey: entry.key, draft: snapshot, count, retryLimit };
	// Each reference in order: its exact URL, or its file's staged descriptor.
	const staged = new Map(fileStages.map(({ position, stage }) => [position, stage]));
	return {
		operationKey: entry.key,
		draft: {
			...(snapshot as SeedreamDraft),
			references: (snapshot as SeedreamDraft).references.map((reference, index) => {
				const stage = staged.get(index + 1);
				return stage
					? { kind: "file", stage }
					: { kind: "url", url: reference.kind === "url" ? reference.url : "" };
			}),
		},
		count,
		retryLimit,
		files: fileStages,
	};
});
// A file Queue whose response was lost. It may already be claimed and charged, so it
// survives edits and renewals, and Retry sends exactly this body again.
let submitted = $state.raw<{ body: object; cleaned: boolean } | null>(null);
let authorized = $state.raw<{ request: QueueInput; terms: ReviewTerms } | null>(null);
let acceptedToken = $state<string | null>(null);
let feedback = $state.raw<{ request: QueueInput; message: string } | null>(null);
// The answer to a Retry. It concerns the earlier request, never this form's Review.
let retryMessage = $state<string | null>(null);
let tabValue = $state("review");
let mounted = true;
onDestroy(() => {
	mounted = false;
});
const terms = $derived(authorized?.request === request ? authorized.terms : null);
// No derived rate basis is published yet (G4b), so a derived row's price is unknown.
const offlineQuote = $derived(
	review &&
		(catalogRow
			? derivedQuote
			: estimateReviewPrice(feeds, review.pricing, batch, browserNow ?? nowMs)),
);
const expiry = $derived.by(() => {
	const price = reviewPriceExpiry(terms?.quote ?? offlineQuote ?? undefined);
	return terms?.files?.length
		? Math.min(...terms.files.map(({ stage }) => stage.deadline), price ?? Infinity)
		: price;
});
const expired = $derived(expiry !== undefined && (browserNow ?? nowMs) >= expiry);
const current = $derived(!expired ? terms : null);
const quote = $derived(current?.quote ?? offlineQuote);
// Once authorised, Review shows what the server bound, which is what Queue claims.
const wording = $derived(bound && (current?.wording ?? bound));
const disclosure = $derived.by(() => {
	if (wording) return wording.d4.length ? wording.d4 : undefined;
	return modelId === zImageModel.id
		? (current?.disclosure ?? zImageDisclosure(operation))
		: current?.editDisclosure;
});
const canQueue = $derived(current && (!current.requiresConsent || acceptedToken === current.token));
const fileWord = $derived(localCopies?.cleaned === false ? "file" : "cleaned copy");
// One upload per file and one edit, each potentially billable.
const fileRequests = $derived(request?.files ? request.files.length + 1 : 0);
// The redacted preview body, with each file position naming its hosted upload instead.
const outgoingBody = $derived.by(() => {
	const body = review?.outgoing.body;
	const files = request?.files;
	if (!body || !files) return body;
	const hosted = new Set(files.map(({ position }) => position));
	const image_urls = (body.input ?? body).image_urls?.map((redacted, index) =>
		!hosted.has(index + 1)
			? redacted
			: files.length === 1
				? "[hosted upload URL]"
				: `[hosted upload URL for reference ${index + 1}]`,
	);
	return body.input ? { ...body, input: { ...body.input, image_urls } } : { ...body, image_urls };
});
const positionsText = (positions: readonly number[]) =>
	positions.length === 1
		? `reference ${positions[0]}`
		: `references ${positions.slice(0, -1).join(", ")} and ${positions.at(-1)}`;
const positionsOf = (answer: unknown) => {
	const positions = (answer as { positions?: unknown } | null)?.positions;
	return Array.isArray(positions) && positions.every((p) => Number.isSafeInteger(p))
		? (positions as number[])
		: [];
};

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

// A file Review or Queue found copies stale. Listed positions are prepared again, and
// their copies' own status describes the preparation; with none listed only the terms
// changed, so every staged copy stays and a fresh Review is needed.
function renewFiles(input: QueueInput, positions: readonly number[]) {
	authorized = null;
	acceptedToken = null;
	if (positions.length) localCopies?.renew(positions);
	else
		feedback = {
			request: input,
			message: "The terms changed. Review again before queuing.",
		};
}

function applyTerms(input: QueueInput, terms: ReviewTerms) {
	// A derived Review must carry what it bound, including an open-absent row's disclosure.
	if (catalogRow) {
		const lines = terms.wording?.d4;
		const shown = [terms.wording?.samePath, terms.wording?.access, terms.wording?.gallery];
		if (
			!Array.isArray(lines) ||
			!lines.every((line) => typeof line === "string" && line.trim()) ||
			!shown.every((text) => typeof text === "string" && text.trim()) ||
			(catalogRow.d4.d4 !== "declared" && lines.length === 0)
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

// The JSON a Review or Queue POST carries: the request without its local bookkeeping.
const wire = ({ files: _files, ...input }: QueueInput) => input;

async function inspect() {
	const input = request;
	if (!input || pending) return;
	pending = "review";
	acceptedToken = null;
	authorized = null;
	feedback = null;
	retryMessage = null;
	tabValue = "review";
	try {
		const response = await post(input.files ? "/image/file-review" : "/image/review", {
			...wire(input),
			acceptUnknown: false,
		});
		// A response for copies that are no longer current is dropped.
		if (!mounted || input !== request) return;
		if (input.files && response.status === 409) {
			const positions = positionsOf(await response.json().catch(() => null));
			// The request may have changed while the body arrived.
			if (mounted && input === request) renewFiles(input, positions);
			return;
		}
		if (input.files && (response.status === 413 || response.status === 400)) {
			const answer: unknown = await response.json().catch(() => null);
			const duplicate = (answer as { error?: unknown } | null)?.error === "duplicate";
			if (response.status === 413 || duplicate) {
				feedback = {
					request: input,
					message: duplicate
						? duplicateMessage(positionsOf(answer))
						: fileLimitMessage(answer, fileWord),
				};
				return;
			}
		}
		if (!response.ok) throw new Error();
		const terms: ReviewTerms = await response.json();
		if (input !== request) return;
		const serverNow = Date.parse(response.headers.get("date") ?? "") || Date.now();
		for (const { position, stage } of terms.files ?? [])
			localCopies?.at(position)?.extend(stage.deadline, serverNow);
		if (applyTerms(input, terms)) await focusReview("inspect");
	} catch {
		feedback = {
			request: input,
			message: "Review is unavailable. Check the provider connection and try again.",
		};
	} finally {
		pending = null;
	}
}

function duplicateMessage(positions: readonly number[]) {
	return positions.length
		? `${positionsText(positions).replace(/^r/, "R")} are the same. Remove the repeat before queuing.`
		: "Two references are the same. Remove the repeat before queuing.";
}

// One file Queue POST. An answer that cannot be read keeps the body for an exact Retry.
// `input` is null for that Retry: its outcome concerns the earlier request, never the
// current Review, its stages or its consent, and only a parsed `stale`, `invalid`,
// `limit` or `duplicate` clears it.
async function sendFile(body: object, cleaned: boolean, input: QueueInput | null) {
	pending = "queue";
	feedback = null;
	retryMessage = null;
	const tell = (message: string) => {
		if (input) feedback = { request: input, message };
		else retryMessage = message;
	};
	const final = (message: string) => {
		if (!input) submitted = null;
		tell(message);
	};
	try {
		const response = await post("/image/file-queue", body);
		if (response.status === 503) {
			const result: { error?: unknown } | null = await response.json().catch(() => null);
			if (result?.error === "closing") {
				tell(
					input
						? "Siluet is shutting down · nothing sent. Review again after it restarts."
						: "Siluet is shutting down · this Retry sent nothing. Check Jobs after it restarts, or Retry then.",
				);
				return;
			}
			if (result?.error === "unavailable") {
				tell(
					`${input ? "Queue" : "Retry"} is unavailable. Nothing was sent. Check the provider connection and try again.`,
				);
				return;
			}
			tell(
				`Upload busy · nothing sent. ${input ? "Queue this Review" : "Retry"} again when another upload finishes.`,
			);
			return;
		}
		if (response.status === 413) {
			// The words describe the copies this body carries, which a Retry may not share with the form.
			final(
				fileLimitMessage(
					await response.json().catch(() => null),
					cleaned ? "cleaned copy" : "file",
				),
			);
			return;
		}
		if (response.status === 409) {
			const result: { error?: unknown; until?: unknown } | null = await response
				.json()
				.catch(() => null);
			if (result?.error === "cooldown") {
				// Nothing was claimed: the Review and its consent queue it after the cooldown.
				// Rounded up to the second; a time no date can hold reads as "shortly".
				const until =
					typeof result.until === "number" && Number.isFinite(result.until)
						? new Date(Math.ceil(result.until / 1000) * 1000)
						: null;
				const valid = until && Number.isFinite(until.getTime()) ? until : null;
				tell(
					`The provider is cooling down. Nothing was sent. ${input ? "Queue" : "Retry"} again${valid ? ` after ${valid.toISOString().slice(0, 19).replace("T", " ")} UTC` : " shortly"}.`,
				);
				return;
			}
			if (result?.error !== "stale") throw new Error();
			if (!input) return final("The earlier request was not queued. Nothing was sent for it.");
			// An answer about copies that are no longer current is dropped.
			if (mounted && input === request) renewFiles(input, positionsOf(result));
			return;
		}
		if (response.status === 400) {
			const result: { error?: unknown } | null = await response.json().catch(() => null);
			if (result?.error === "duplicate") return final(duplicateMessage(positionsOf(result)));
			if (result?.error !== "invalid") throw new Error();
			if (!input) return final("The earlier request was not queued. Nothing was sent for it.");
			authorized = null;
			acceptedToken = null;
			tell(`Review the ${fileCount === 1 ? "file" : "files"} again before queuing.`);
			return;
		}
		if (!response.ok) throw new Error();
		const { jobId } = await response.json();
		if (typeof jobId !== "string" || !jobId) throw new Error();
		submitted = null;
		if (mounted) await goto(`/jobs#job-${encodeURIComponent(jobId)}`);
	} catch {
		submitted = { body, cleaned };
		tell("Queue confirmation is unavailable. Check Jobs, or Retry to send the same request again.");
	} finally {
		pending = null;
	}
}

function retrySubmitted() {
	const lost = submitted;
	if (!lost || pending) return;
	void sendFile(lost.body, lost.cleaned, null);
}

async function queue() {
	const input = request;
	if (!input || !current || !canQueue || pending || tabValue !== "review") return;
	if (input.files && current.files) {
		const reviewed = new Map(current.files.map(({ position, stage }) => [position, stage]));
		const draft = input.draft as FileDraft;
		await sendFile(
			{
				...wire(input),
				draft: {
					...draft,
					references: draft.references.map((reference, index) => {
						const stage = reviewed.get(index + 1);
						return stage ? { kind: "file", stage } : reference;
					}),
				},
				token: current.token,
				acceptUnknown: acceptedToken === current.token,
			},
			input.files.some(({ stage }) => stage.transform !== "original"),
			input,
		);
		return;
	}

	pending = "queue";
	feedback = null;
	retryMessage = null;
	const token = current.token;
	try {
		const response = await post("/image/queue", {
			...wire(input),
			token,
			acceptUnknown: acceptedToken === token,
		});
		if (response.status === 429) {
			const result: { until?: unknown } | null = await response.json().catch(() => null);
			// Expiry may have cleared this Review while the request was in flight.
			if (!mounted || input !== request || current?.token !== token) return;
			// No job was claimed, so the same Review token and consent queue it later.
			const until = result?.until;
			const date = new Date(
				typeof until === "number" ? Math.ceil(until / 1000) * 1000 : Number.NaN,
			);
			const deadline = Number.isNaN(date.getTime())
				? " shortly"
				: ` after ${date
						.toISOString()
						.replace(/\.\d{3}Z$/, "")
						.replace("T", " ")} UTC`;
			feedback = {
				request: input,
				message: `The provider is cooling down. Nothing was sent. Click Queue again${deadline}.`,
			};
			return;
		}
		if (response.status === 409 || response.status === 400) {
			const result: { review?: ReviewTerms } | null = await response.json().catch(() => null);
			if (!mounted || input !== request) return;
			const fresh = result?.review;
			authorized = null;
			acceptedToken = null;
			if (!fresh || applyTerms(input, fresh)) {
				feedback = {
					request: input,
					message: fresh
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
				message: reviewed.files?.length
					? "File Review expired. Review the request again before queuing."
					: "The reviewed rates expired. Review the request again before queuing.",
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
				{#if wording}
					<!-- Shown offline: what Siluet checked, and the path this model shares. -->
					<div class={styles.fact}>
						<dt class={styles.term}>Route evidence</dt>
						<dd class={styles.detail} data-studio-route-evidence>
							<p>{wording.access}</p>
							{#if filtering?.declaredField}
								<p>The model contract declares <code>{filtering.declaredField}: false</code>.</p>
							{/if}
							{#if refusedAt}
								<p data-studio-refusal>{refusalNote(refusedAt)}</p>
							{/if}
						</dd>
					</div>
					<div class={styles.fact}>
						<dt class={styles.term}>Contract</dt>
						<dd class={styles.detail} data-studio-contract>{wording.samePath}</dd>
					</div>
				{:else if entry && connected}
					<div class={styles.fact}>
						<dt class={styles.term}>Route evidence</dt>
						<dd class={styles.detail}>
							{entry.key.provider === "poyo"
								? "The balance check accepted this key. Access to this model is unconfirmed."
								: "The global image model list included this model for this key."}
							{#if filtering?.declaredField}
								The model contract declares <code>{filtering.declaredField}: false</code>.
							{/if}
							{#if refusedAt}
								<p data-studio-refusal>{refusalNote(refusedAt)}</p>
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
								autoFraming={references.length > 1 && draft.options.aspectRatio === "auto"}
							/>
						{/if}
					</dd>
				</div>
				<div class={styles.fact}>
					<dt class={styles.term}>Expected type</dt>
					<dd class={styles.detail} data-studio-expected-type>
						{#if review?.expected}
							<p>{review.expected.name}, requested as <code>{review.expected.format}</code></p>
						{:else if review}
							<p>The provider's choice. This model has no output format option.</p>
						{:else}
							<p>Complete the request to see the expected type.</p>
						{/if}
						<p class={styles.note}>
							Save records the type Gallery verifies: PNG, JPEG or still WebP. Any other type stays
							in Jobs.
						</p>
						{#if wording}
							<p class={styles.note} data-studio-gallery>{wording.gallery}</p>
						{/if}
					</dd>
				</div>
				<div class={styles.fact}>
					<dt class={styles.term}>Price</dt>
					<dd class={styles.detail} data-studio-price aria-live="polite">
						{#if request?.files}
							<p>
								{fileCount === 1 ? "Upload cost" : "Upload costs"} unknown. The estimate below
								covers the edit.
							</p>
						{/if}
						{#if selectedProvider === "toapis"}
							<span class={styles.note}>Standard-route pricing</span>
						{/if}
						{#if quote?.status === "known"}
							<p>Estimated {quote.perRequest} {providerName} credits per request</p>
							{#if quote.unit === "toapis_credit"}
								<p>Standard-route estimate ${quote.usd.perRequest} USD.</p>
								{#if quote.referenceImages}
									<p>{reviewReferenceCharge(quote.referenceImages)}</p>
								{/if}
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
			{#each localFiles ?? [] as { position, key, copy } (key)}
				<LocalCopyDetails
					{copy}
					headingId={`${headingId}-file-${key}`}
					position={fileCount === 1 ? null : position}
				/>
			{/each}
			{#if current?.files?.length}
				{@const deadline = Math.min(...current.files.map(({ stage }) => stage.deadline))}
				<p class={styles.note}>
					Review valid until
					<time datetime={new Date(deadline).toISOString()}
						>{new Date(deadline).toISOString().slice(11, 19)} UTC</time
					>.
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
					<select
						class={styles.batchSelect}
						bind:value={() => count, (value) => (batchCount = value)}
						disabled={!!catalogRow}
					>
						{#each reviewBatchCounts as requests (requests)}
							<option value={requests}>{requests} {requests === 1 ? "request" : "requests"}</option>
						{/each}
					</select>
				</label>
				<label class={styles.batchLabel}>
					Additional attempts per request
					<select
						class={styles.batchSelect}
						bind:value={() => retryLimit, (value) => (batchRetries = value)}
						disabled={!!catalogRow}
					>
						{#each reviewRetryLimits as retries (retries)}
							<option value={retries}>{retries}</option>
						{/each}
					</select>
				</label>
			</div>
			<p class={styles.note}>
				{catalogRow
					? "This model queues one request with zero additional attempts."
					: modelId === zImageModel.id
						? "Z-Image batches are available for offline estimates. Queue supports one request with zero retries."
						: "Each request runs independently. Initial batch estimates exclude retries."}
			</p>
		</Tabs.Content>

		<Tabs.Content value="outgoing" class={styles.tabContent}>
			{#if review}
				<div class={styles.wire}>
					{#if request?.files && selectedProvider && selectedProvider in fileUploadRoutes}
						{@const provider = selectedProvider as keyof typeof fileUploadRoutes}
						{#each request.files as { position, stage } (position)}
							<p>
								{fileCount === 1
									? "Upload"
									: `Upload ${position === request.files[0].position ? "first" : "then"} · reference ${position}`}
							</p>
							<p><code>POST {fileUploadRoutes[provider]}</code></p>
							<p><code>Authorization: Bearer [API key hidden]</code></p>
							<p>
								Multipart file · {neutralFilename(stage.mime)} · {stage.mime} ·
								{stage.size.toLocaleString("en-US")} bytes (limit
								{fileByteLimit[provider].toLocaleString("en-US")}) · default storage path and
								purpose
							</p>
						{/each}
						<p>Edit</p>
					{/if}
					<p><code>{review.outgoing.method} {review.outgoing.url}</code></p>
					<p><code>Authorization: Bearer [API key hidden]</code></p>
					<!-- svelte-ignore a11y_no_noninteractive_tabindex (Keyboard users must be able to scroll the JSON.) -->
					<!-- biome-ignore lint/a11y/noNoninteractiveTabindex: Keyboard access to the scrollable JSON. -->
					<section class={styles.jsonScroller} tabindex="0" aria-label="JSON request body">
						<pre class={styles.json}><code>{JSON.stringify(outgoingBody, null, 2)}</code></pre>
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
			{current.files?.length
				? current.files.length === 1
					? "I accept the unknown total cost of the upload and edit, the provider access and retention terms above, and that the uploaded copy may stay accessible even if the edit never runs."
					: "I accept the unknown total cost of the uploads and edit, the provider access and retention terms above, and that uploaded copies may stay accessible even if the edit never runs."
				: count > 1 || retryLimit > 0
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
		{#if submitted || retryMessage}
			{#if submitted}
				<button
					type="button"
					class={styles.queue}
					disabled={!!pending}
					onclick={retrySubmitted}
					aria-describedby={`${headingId}-retry`}
				>
					Retry
				</button>
				<p id={`${headingId}-retry`} class={styles.exposure}>
					Retry resends the earlier reviewed request unchanged, whatever this form now shows.
				</p>
			{/if}
			<p class={styles.exposure} aria-live="polite">{retryMessage ?? ""}</p>
		{/if}
		<p id={`${headingId}-exposure`} class={styles.exposure} aria-live="polite">
			{#if fileRequests}
				Up to {fileRequests} potentially billable requests: {fileCount}
				{fileCount === 1 ? "upload" : "uploads"} and one edit.
			{:else}
				Up to {maxAttempts} potentially billable {maxAttempts === 1 ? "submission" : "submissions"}.
			{/if}
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
