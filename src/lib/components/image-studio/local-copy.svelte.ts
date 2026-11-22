import { untrack } from "svelte";
import {
	type MediaDescriptor,
	parseStageDescriptor,
} from "#lib/shared/media-staging/descriptor.ts";
import { localImageLimitRefusal } from "#lib/shared/media-staging/limits.ts";

const unavailableMessage = "Image preparation unavailable.";
// The server prepares one file at a time and refuses another while an abandoned
// preparation settles, which takes at most its 30-second limit. A replacement
// waits that long for the slot.
const busyWaitMs = 35_000;
const busyDelayMs = 500;

function pause(ms: number, signal: AbortSignal) {
	return new Promise<void>((resolve) => {
		const timer = setTimeout(resolve, ms);
		signal.addEventListener(
			"abort",
			() => {
				clearTimeout(timer);
				resolve();
			},
			{ once: true },
		);
	});
}

/**
 * Cleans the attached file as soon as it is attached, with no confirmation, and
 * keeps one private copy for it. Construct it while a component initializes:
 * replacing or removing the file, or unmounting, retires the copy.
 */
export class LocalCopy {
	file = $state.raw<File | null>(null);
	stage = $state.raw<MediaDescriptor | null>(null);
	pending = $state(false);
	/** A failure when `failed`, otherwise why a copy is being cleaned again. */
	message = $state<string | null>(null);
	failed = $state(false);
	status = $derived.by(() => {
		if (this.pending)
			return this.message
				? `${this.message} Cleaning and verifying it again…`
				: "Cleaning and verifying the file…";
		if (this.failed) return this.message ?? unavailableMessage;
		return this.stage ? "Cleaned copy ready." : "";
	});

	// One opaque draft per attached file. Cleaning again replaces its earlier copy.
	#draftId = crypto.randomUUID();
	#used = false;
	#preparing: AbortController | null = null;
	#expiry: ReturnType<typeof setTimeout> | undefined;
	// The copy came from automatic recovery and has not loaded yet. If it is lost
	// too, the creator decides whether to try again.
	#recovered = false;

	constructor(source: () => File | null) {
		$effect(() => {
			const file = source();
			untrack(() => this.#attach(file));
		});
		$effect(() => () => this.#detach());
	}

	/** Clean the attached file again after a failure. */
	retry() {
		if (this.file && !this.pending) void this.#prepare(false);
	}

	/** The preview of `stage` loaded. */
	loaded(stage: MediaDescriptor) {
		if (stage === this.stage) this.#recovered = false;
	}

	/** The preview of `stage` failed to load: the server no longer has it. */
	unavailable(stage: MediaDescriptor) {
		if (stage !== this.stage) return;
		this.#retire();
		this.stage = null;
		this.message = "The cleaned copy is no longer available.";
		if (this.#recovered) this.failed = true;
		else void this.#prepare(true);
	}

	#attach(file: File | null) {
		if (file === this.file) return;
		this.#detach();
		this.file = file;
		if (file) void this.#prepare(false);
	}

	#detach() {
		this.#preparing?.abort();
		this.#preparing = null;
		this.#retire();
		this.file = null;
		this.stage = null;
		this.message = null;
		this.failed = false;
		this.pending = false;
		this.#recovered = false;
	}

	// Remove every copy of this draft, including one a request we abandoned may have
	// committed, and continue with a fresh draft.
	#retire() {
		clearTimeout(this.#expiry);
		if (this.#used) {
			void fetch(`/image/files/${this.#draftId}`, { method: "DELETE", keepalive: true }).catch(
				() => {},
			);
			this.#draftId = crypto.randomUUID();
			this.#used = false;
		}
	}

	#show(staged: MediaDescriptor, serverNow: number) {
		this.stage = staged;
		this.message = null;
		clearTimeout(this.#expiry);
		// The server removes an idle copy at its deadline. Clean the file again then.
		this.#expiry = setTimeout(
			() => {
				if (this.stage !== staged) return;
				this.stage = null;
				this.message = "The cleaned copy expired.";
				void this.#prepare(true);
			},
			Math.max(0, staged.deadline - serverNow),
		);
	}

	#fail(message: string) {
		this.message = message;
		this.failed = true;
	}

	async #prepare(automatic: boolean) {
		const file = this.file;
		if (!file) return;
		const abort = new AbortController();
		this.#preparing = abort;
		this.pending = true;
		this.failed = false;
		if (!automatic) this.message = null;
		this.#recovered = automatic;
		// The earlier copy stays on the server until this request settles. Success
		// replaces it there; any other outcome retires the draft and both copies.
		this.stage = null;
		clearTimeout(this.#expiry);
		this.#used = true;
		let staged: MediaDescriptor | null = null;
		try {
			const waitUntil = Date.now() + busyWaitMs;
			for (;;) {
				const response = await fetch(`/image/files/${this.#draftId}`, {
					method: "POST",
					body: file,
					headers: { "Content-Type": "application/octet-stream" },
					signal: abort.signal,
				});
				const result: unknown = await response.json().catch(() => null);
				if (this.#preparing !== abort) return;
				staged = response.ok ? parseStageDescriptor(result) : null;
				if (staged?.draft === this.#draftId) {
					this.#show(staged, Date.parse(response.headers.get("date") ?? "") || Date.now());
					return;
				}
				staged = null;
				const { error, code } =
					result && typeof result === "object"
						? (result as { error?: unknown; code?: unknown })
						: {};
				if (code === "busy" && Date.now() < waitUntil) {
					await pause(busyDelayMs, abort.signal);
					if (this.#preparing !== abort) return;
					continue;
				}
				this.#fail(
					response.status === 413
						? localImageLimitRefusal.join(" ")
						: typeof error === "string"
							? error
							: unavailableMessage,
				);
				return;
			}
		} catch {
			if (this.#preparing === abort) this.#fail(unavailableMessage);
		} finally {
			if (this.#preparing === abort) {
				if (!staged) this.#retire();
				this.#preparing = null;
				this.pending = false;
			}
		}
	}
}
