<script lang="ts">
import { onDestroy, untrack } from "svelte";
import {
	type MediaDescriptor,
	parseStageDescriptor,
} from "#lib/shared/media-staging/descriptor.ts";
import { localImageLimitRefusal } from "#lib/shared/media-staging/limits.ts";
import * as styles from "./local-copy-styles.ts";

let { file, headingId }: { file: File; headingId: string } = $props();

// One opaque draft per prepared file. Preparing again replaces its earlier copy.
let draftId = crypto.randomUUID();
let used = false;
let stage = $state.raw<MediaDescriptor | null>(null);
let pending = $state(false);
let message = $state<string | null>(null);
let preparing: { file: File; abort: AbortController } | null = null;
let expiry: ReturnType<typeof setTimeout> | undefined;

const resource = (staged: MediaDescriptor) => `/image/files/${staged.draft}/${staged.handle}`;
const caption = $derived.by(() => {
	if (!stage) return "";
	const { mime, size } = stage;
	const rounded =
		size < 1_000_000 ? `${(size / 1000).toFixed(1)} KB` : `${(size / 1_000_000).toFixed(2)} MB`;
	return `${mime === "image/png" ? "PNG" : "JPEG"} · ${rounded} (${size.toLocaleString("en-US")} bytes)`;
});

// Remove every copy of this draft, including one a request we abandoned may have
// committed, and continue with a fresh draft.
function retireDraft() {
	clearTimeout(expiry);
	if (used) {
		void fetch(`/image/files/${draftId}`, { method: "DELETE", keepalive: true }).catch(() => {});
		draftId = crypto.randomUUID();
		used = false;
	}
}

function show(staged: MediaDescriptor, serverNow: number) {
	stage = staged;
	clearTimeout(expiry);
	// The server removes an idle copy at its deadline. Stop showing it then.
	expiry = setTimeout(
		() => {
			if (stage !== staged) return;
			stage = null;
			message = "The cleaned copy expired. Prepare it again.";
		},
		Math.max(0, staged.deadline - serverNow),
	);
}

function unavailable() {
	retireDraft();
	stage = null;
	message = "The cleaned copy is no longer available. Prepare it again.";
}

// A different file, or leaving Review, retires the preparation and its copies.
let shown: File | undefined;
$effect(() => {
	const next = file;
	untrack(() => {
		if (shown === next) return;
		shown = next;
		preparing?.abort.abort();
		preparing = null;
		retireDraft();
		stage = null;
		message = null;
		pending = false;
	});
});
onDestroy(() => {
	preparing?.abort.abort();
	retireDraft();
});

async function prepare() {
	if (pending) return;
	const current = { file, abort: new AbortController() };
	preparing = current;
	pending = true;
	message = null;
	// The earlier copy stays on the server until this request settles. Success
	// replaces it there; any other outcome retires the draft and both copies.
	stage = null;
	clearTimeout(expiry);
	used = true;
	let staged: MediaDescriptor | null = null;
	try {
		const response = await fetch(`/image/files/${draftId}`, {
			method: "POST",
			body: current.file,
			headers: { "Content-Type": "application/octet-stream" },
			signal: current.abort.signal,
		});
		const result: unknown = await response.json().catch(() => null);
		if (preparing !== current) return;
		staged = response.ok ? parseStageDescriptor(result) : null;
		if (staged?.draft === draftId) {
			show(staged, Date.parse(response.headers.get("date") ?? "") || Date.now());
			return;
		}
		staged = null;
		const error =
			result && typeof result === "object" && "error" in result ? result.error : undefined;
		message =
			response.status === 413
				? localImageLimitRefusal.join(" ")
				: typeof error === "string"
					? error
					: "Image preparation unavailable. Try again.";
	} catch {
		if (preparing === current) message = "Image preparation unavailable. Try again.";
	} finally {
		if (preparing === current) {
			if (!staged) retireDraft();
			preparing = null;
			pending = false;
		}
	}
}
</script>

<section class={styles.section} aria-labelledby={`${headingId}-local-copy`}>
	<h3 class={styles.heading} id={`${headingId}-local-copy`}>Local copy</h3>
	<p class={styles.note}>
		Siluet cleans a private copy on this computer. Preparing makes no provider calls, and your
		original file stays unchanged.
	</p>
	<button
		type="button"
		id={`${headingId}-prepare`}
		class={styles.prepare}
		disabled={pending}
		onclick={prepare}
	>
		{pending ? "Preparing local copy…" : stage ? "Prepare again" : "Prepare local copy"}
	</button>
	<p class={styles.note} role="status" aria-live="polite">
		{#if pending}
			Cleaning and verifying the file…
		{:else if message}
			{message}
		{:else if stage}
			Cleaned copy ready.
		{/if}
	</p>
	{#if stage}
		<figure class={styles.figure}>
			<img
				class={styles.preview}
				src={resource(stage)}
				alt="Cleaned local copy"
				onerror={unavailable}
			>
			<figcaption class={styles.note}>{caption}</figcaption>
		</figure>
		{#if stage.transform === "reencoded-rotation"}
			<p class={styles.disclosure}>
				<strong>Re-encoded to apply rotation.</strong> The camera orientation was applied to the
				pixels and the image was saved once more as a JPEG at quality 95, which can soften fine
				detail.
			</p>
		{/if}
		<h4 class={styles.subheading} id={`${headingId}-survival`}>What survives cleanup</h4>
		<ul class={styles.list} aria-labelledby={`${headingId}-survival`}>
			<li>
				Removed: EXIF and GPS, XMP and IPTC including authorship and AI-source tags, comments,
				thumbnails, editing history and recognized embedded Content Credentials.
			</li>
			<li>
				Kept: an embedded ICC color profile, exactly. Its creator, copyright, creation date, device
				names, descriptions and private fields can survive.
			</li>
			<li>Watermarks in the picture itself survive.</li>
		</ul>
	{/if}
</section>
