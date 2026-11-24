import { untrack } from "svelte";
import type { CleaningSetting } from "#lib/shared/media-staging/cleaning.ts";
import {
	type MediaDescriptor,
	parseStageDescriptor,
} from "#lib/shared/media-staging/descriptor.ts";
import { localImageLimitRefusal } from "#lib/shared/media-staging/limits.ts";
import { invalidateAll } from "$app/navigation";

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

const record = (value: unknown): Record<string, unknown> =>
	value && typeof value === "object" ? (value as Record<string, unknown>) : {};
const revisionOf = (value: unknown) => {
	const revision = record(value).revision;
	return typeof revision === "number" && Number.isSafeInteger(revision) ? revision : null;
};

/**
 * Prepares the attached file as soon as it is attached, with no confirmation, and
 * keeps one private staged copy for it: cleaned, or checked and unchanged when the
 * owner turned cleaning off (D10). Construct it while a component initializes:
 * replacing or removing the file, unmounting, or leaving the document retires the copy.
 */
export class LocalCopy {
	#cleaning: () => CleaningSetting | null = () => null;
	// The newest setting a state check or staging response reported. It can be newer than
	// the page data, which reloads only after a change is confirmed.
	#latest = $state.raw<CleaningSetting | null>(null);
	file = $state.raw<File | null>(null);
	stage = $state.raw<MediaDescriptor | null>(null);
	pending = $state(false);
	/** A failure when `failed`, otherwise why a copy is being prepared again. */
	message = $state<string | null>(null);
	failed = $state(false);
	/** Whether the copy is (or will be) cleaned: a staged copy's own mode, else the setting. */
	cleaned = $derived(
		this.stage ? this.stage.transform !== "original" : (this.#setting()?.enabled ?? true),
	);
	status = $derived.by(() => {
		if (this.pending) {
			const action = this.cleaned ? "Cleaning and verifying the file…" : "Checking the file…";
			return this.message ? `${this.message} ${action}` : action;
		}
		if (this.failed) return this.message ?? unavailableMessage;
		if (!this.stage) return "";
		return this.cleaned ? "Cleaned copy ready." : "File checked · Not cleaned.";
	});

	// One opaque draft per attached file. Preparing again replaces its earlier copy.
	#draftId = crypto.randomUUID();
	#used = false;
	#preparing: AbortController | null = null;
	#expiry: ReturnType<typeof setTimeout> | undefined;
	// The copy came from automatic recovery and has not loaded yet. If it is lost
	// too, the creator decides whether to try again.
	#recovered = false;
	// An expired copy is prepared again once per attach or Try again, so an idle
	// tab does not hold scratch space and the preparation slot indefinitely.
	#renewed = false;
	// The page was hidden while a copy was ready or being prepared. Only then does
	// a page restored from the back-forward cache prepare the file again.
	#resume = false;
	// The setting revision the server admitted the latest preparation under.
	#revision: number | null = null;
	// The newest revision a settings check reported, so a late response can be retired.
	#known: number | null = null;
	#checking = false;

	constructor(source: () => File | null, cleaning: () => CleaningSetting | null = () => null) {
		this.#cleaning = cleaning;
		$effect(() => {
			const file = source();
			untrack(() => this.#attach(file));
		});
		$effect(() => () => this.#detach());
		// A reload or closed tab never unmounts the component. A page restored from
		// the back-forward cache prepares its file again.
		$effect(() => {
			const hide = () => this.#suspend();
			const show = (event: PageTransitionEvent) => {
				if (!event.persisted || !this.file || !this.#resume) return;
				this.#resume = false;
				// An automatic recovery stays automatic, so its retry limit survives.
				void this.#prepare(this.#recovered);
			};
			const visible = () => {
				if (document.visibilityState === "visible") void this.#checkSetting();
			};
			addEventListener("pagehide", hide);
			addEventListener("pageshow", show);
			document.addEventListener("visibilitychange", visible);
			return () => {
				removeEventListener("pagehide", hide);
				removeEventListener("pageshow", show);
				document.removeEventListener("visibilitychange", visible);
			};
		});
	}

	/** Prepare the attached file again after a failure. */
	retry() {
		if (this.file && !this.pending) this.#restart();
	}

	/**
	 * Prepare the attached file again without Try again, because a Review or Queue found
	 * its copy stale. The setting may have changed since.
	 */
	renew() {
		if (!this.file) return;
		void this.#readSetting()
			.then((current) => {
				// The preparation settled before this check reported a newer setting.
				const admitted = this.#revision;
				if (current === null || !this.file || this.pending || admitted === null) return;
				if (admitted < current) this.#replace();
			})
			.catch(() => {});
		this.#replace();
	}

	/** A Review moved the copy's idle deadline. Keep the same copy and its identity. */
	extend(deadline: number, serverNow: number) {
		const stage = this.stage;
		if (stage) this.#schedule(stage, deadline, serverNow);
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
		this.message = "The staged file is no longer available.";
		if (this.#recovered) this.failed = true;
		else void this.#prepare(true);
	}

	#attach(file: File | null) {
		if (file === this.file) return;
		this.#detach();
		this.file = file;
		if (file) this.#restart();
	}

	#restart() {
		this.#renewed = false;
		void this.#prepare(false);
	}

	// A setting change: drop the old preparation and its late response, then prepare
	// once under the new setting. Not a recovery, so its failure offers Try again.
	#replace() {
		this.#preparing?.abort();
		this.#preparing = null;
		this.#retire();
		this.stage = null;
		this.#renewed = false;
		void this.#prepare(false, false);
	}

	// When the tab is shown again, ask whether the setting changed since this file's
	// preparation was admitted. Only a change reloads the page data and prepares again.
	async #checkSetting() {
		if (!this.file || this.#checking) return;
		this.#checking = true;
		try {
			const current = await this.#readSetting();
			if (current === null || !this.file) return;
			const admitted = this.#revision ?? this.#cleaning()?.revision ?? null;
			// A preparation still in flight is compared when its response arrives; the
			// mode it describes meanwhile already follows the newer setting.
			if (this.pending || admitted === current) return;
			await invalidateAll();
			if (this.file) this.#replace();
		} catch {
			// The next visibility change or a stale Review asks again.
		} finally {
			this.#checking = false;
		}
	}

	#setting() {
		const page = this.#cleaning();
		const latest = this.#latest;
		return latest && (!page || latest.revision >= page.revision) ? latest : page;
	}

	// Keep a reported setting when it is at least as new as the one already known.
	#learn(value: unknown) {
		const { enabled } = record(value);
		const revision = revisionOf(value);
		if (typeof enabled !== "boolean" || revision === null) return;
		if (!this.#latest || revision >= this.#latest.revision) this.#latest = { enabled, revision };
	}

	async #readSetting() {
		const response = await fetch("/settings/files/state", { cache: "no-store" });
		const result: unknown = response.ok ? await response.json().catch(() => null) : null;
		this.#learn(result);
		const revision = revisionOf(result);
		// A preparation admitted under an older revision is retired when it answers.
		if (revision !== null) this.#known = Math.max(this.#known ?? revision, revision);
		return revision;
	}

	// Retire the copy but keep the file, which a restored page prepares again.
	#suspend() {
		this.#resume = !this.failed && (this.stage !== null || this.pending);
		this.#preparing?.abort();
		this.#preparing = null;
		this.#retire();
		this.stage = null;
		this.pending = false;
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
		this.#renewed = false;
		this.#revision = null;
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
		this.#schedule(staged, staged.deadline, serverNow);
	}

	// The server removes an idle copy at its deadline. Prepare the file again then,
	// once; a copy that is already past it counts as expired.
	#schedule(staged: MediaDescriptor, deadline: number, serverNow: number) {
		clearTimeout(this.#expiry);
		const remaining = deadline - serverNow;
		if (remaining <= 0) {
			this.#expire();
			return;
		}
		this.#expiry = setTimeout(() => {
			if (this.stage !== staged) return;
			if (this.#renewed) {
				this.#expire();
				return;
			}
			this.#renewed = true;
			this.stage = null;
			this.message = "The staged file expired.";
			void this.#prepare(true);
		}, remaining);
	}

	#expire() {
		this.#retire();
		this.stage = null;
		this.#fail("The staged file expired.");
	}

	#fail(message: string) {
		this.message = message;
		this.failed = true;
	}

	async #prepare(automatic: boolean, recovery = automatic) {
		const file = this.file;
		if (!file) return;
		const abort = new AbortController();
		this.#preparing = abort;
		this.pending = true;
		this.failed = false;
		if (!automatic) this.message = null;
		this.#recovered = recovery;
		// The earlier copy stays on the server until this request settles. Success
		// replaces it there; any other outcome retires the draft and both copies.
		this.stage = null;
		clearTimeout(this.#expiry);
		this.#used = true;
		let staged: MediaDescriptor | null = null;
		let changed = false;
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
				const { stage, error, code } = record(result);
				this.#revision = revisionOf(result) ?? this.#revision;
				this.#learn(result);
				// The setting changed while this file was prepared: prepare it once more at once.
				if (code === "cleaning-changed" && !changed) {
					changed = true;
					continue;
				}
				// Another check already saw a newer setting than this response was admitted under.
				if (this.#known !== null && this.#revision !== null && this.#revision < this.#known) {
					if (!changed) {
						changed = true;
						continue;
					}
				}
				staged = response.ok ? parseStageDescriptor(stage) : null;
				if (staged?.draft === this.#draftId) {
					this.#show(staged, Date.parse(response.headers.get("date") ?? "") || Date.now());
					return;
				}
				staged = null;
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
