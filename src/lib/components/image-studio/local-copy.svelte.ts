import { untrack } from "svelte";
import type { CleaningSetting } from "#lib/shared/media-staging/cleaning.ts";
import {
	type MediaDescriptor,
	parseStageDescriptor,
} from "#lib/shared/media-staging/descriptor.ts";
import { localImageLimitRefusal } from "#lib/shared/media-staging/limits.ts";
import type { SessionInit } from "#lib/shared/owner/authenticated-fetch.ts";
import { sessionClient } from "#lib/shared/owner/session-client.ts";
import { invalidateAll } from "$app/navigation";
import {
	duplicatePositions,
	oneAtATime,
	PendingDeletes,
	type SlotFile,
	SlotFiles,
} from "./local-copies.ts";

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
 * The tab's view of the owner's cleaning setting (D10), shared by every attached file:
 * the newest setting any check or staging response reported, and the newest revision
 * known, so a preparation admitted under an older one is retired wherever it answers.
 */
class CleaningWatch {
	#page: () => CleaningSetting | null;
	// It can be newer than the page data, which reloads only after a change is confirmed.
	#latest = $state.raw<CleaningSetting | null>(null);
	known: number | null = null;
	/** Told when a newer revision than any copy was admitted under becomes known. */
	onNewer: (revision: number) => void = () => {};

	constructor(page: () => CleaningSetting | null) {
		this.#page = page;
	}

	get setting() {
		const page = this.#page();
		const latest = this.#latest;
		return latest && (!page || latest.revision >= page.revision) ? latest : page;
	}

	get pageRevision() {
		return this.#page()?.revision ?? null;
	}

	/** Keep a reported setting when it is at least as new as the one already known. */
	learn(value: unknown) {
		const { enabled } = record(value);
		const revision = revisionOf(value);
		if (typeof enabled !== "boolean" || revision === null) return;
		if (!this.#latest || revision >= this.#latest.revision) this.#latest = { enabled, revision };
		this.notice(revision);
	}

	notice(revision: number) {
		if (this.known !== null && revision <= this.known) return;
		this.known = revision;
		this.onNewer(revision);
	}

	async read() {
		const response = await fetch("/settings/files/state", { cache: "no-store" });
		const result: unknown = response.ok ? await response.json().catch(() => null) : null;
		this.learn(result);
		return revisionOf(result);
	}
}

type Pool = {
	watch: CleaningWatch;
	turn: ReturnType<typeof oneAtATime>;
	deletes: PendingDeletes;
};

/**
 * Prepares one attached file as soon as it is attached, with no confirmation, and keeps
 * one private staged copy for it in its own draft: cleaned, or checked and unchanged when
 * the owner turned cleaning off (D10). Removing the file or leaving the document retires it.
 */
export class LocalCopy {
	#pool: Pool;
	readonly file: File;
	stage = $state.raw<MediaDescriptor | null>(null);
	pending = $state(false);
	/** A failure when `failed`, otherwise why a copy is being prepared again. */
	message = $state<string | null>(null);
	failed = $state(false);
	/** Whether the copy is (or will be) cleaned: a staged copy's own mode, else the setting. */
	get cleaned() {
		return this.stage
			? this.stage.transform !== "original"
			: (this.#pool.watch.setting?.enabled ?? true);
	}
	get status() {
		if (this.pending) {
			const action = this.cleaned ? "Cleaning and verifying the file…" : "Checking the file…";
			return this.message ? `${this.message} ${action}` : action;
		}
		if (this.failed) return this.message ?? unavailableMessage;
		if (!this.stage) return "";
		return this.cleaned ? "Cleaned copy ready." : "File checked · Not cleaned.";
	}

	// One opaque draft per attached file. Preparing again replaces its earlier copy.
	#draftId = crypto.randomUUID();
	// The session this copy was attached under. Its staging and cleanup go out only with that
	// session's bearer; after a session change they send nothing.
	#session = sessionClient().bound()?.sessionId;
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
	revision: number | null = null;
	#disposed = false;

	constructor(file: File, pool: Pool) {
		this.file = file;
		this.#pool = pool;
		this.#restart();
	}

	/** Prepare the attached file again after a failure. */
	retry() {
		if (!this.pending) this.#restart();
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

	/**
	 * A setting change: drop the old preparation and its late response, then prepare once
	 * under the new setting, after every earlier deletion. Its failure offers Try again.
	 */
	replace() {
		if (this.#disposed) return;
		this.#preparing?.abort();
		this.#preparing = null;
		this.#retire();
		this.stage = null;
		this.#renewed = false;
		void this.#prepare(false, false);
	}

	/** Prepared under an older revision than the newest known. */
	get outdated() {
		const known = this.#pool.watch.known;
		const admitted = this.revision ?? this.#pool.watch.pageRevision;
		return !this.pending && known !== null && admitted !== null && admitted < known;
	}

	/** Retire the copy but keep the file, which a restored page prepares again. */
	suspend() {
		this.#resume = !this.failed && (this.stage !== null || this.pending);
		this.#preparing?.abort();
		this.#preparing = null;
		this.#retire();
		this.stage = null;
		this.pending = false;
	}

	resume() {
		if (!this.#resume) return;
		this.#resume = false;
		// An automatic recovery stays automatic, so its retry limit survives.
		void this.#prepare(this.#recovered);
	}

	dispose() {
		this.#disposed = true;
		this.#preparing?.abort();
		this.#preparing = null;
		this.#retire();
		this.stage = null;
		this.pending = false;
	}

	#restart() {
		this.#renewed = false;
		void this.#prepare(false);
	}

	// Remove every copy of this draft, including one a request we abandoned may have
	// committed, and continue with a fresh draft.
	#retire() {
		clearTimeout(this.#expiry);
		if (this.#used) {
			this.#pool.deletes.track(
				fetch(`/image/files/${this.#draftId}`, {
					method: "DELETE",
					keepalive: true,
					siluetSession: this.#session,
				} as SessionInit),
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
		if (this.#disposed) return;
		const file = this.file;
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
		let staged: MediaDescriptor | null = null;
		const { watch, turn, deletes } = this.#pool;
		try {
			await turn(async () => {
				// Copies removed before this one free their scratch space first.
				await deletes.settled();
				if (this.#preparing !== abort) return;
				this.#used = true;
				let changed = false;
				const waitUntil = Date.now() + busyWaitMs;
				for (;;) {
					const response = await fetch(`/image/files/${this.#draftId}`, {
						method: "POST",
						body: file,
						headers: { "Content-Type": "application/octet-stream" },
						signal: abort.signal,
						siluetSession: this.#session,
					} as SessionInit);
					const result: unknown = await response.json().catch(() => null);
					if (this.#preparing !== abort) return;
					const { stage, error, code } = record(result);
					this.revision = revisionOf(result) ?? this.revision;
					watch.learn(result);
					// The setting changed while this file was prepared: prepare it once more at once.
					if (code === "cleaning-changed" && !changed) {
						changed = true;
						continue;
					}
					// Another check already saw a newer setting than this response was admitted under.
					if (watch.known !== null && this.revision !== null && this.revision < watch.known) {
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
			});
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

/**
 * The staged copies of a draft's attached JPEG and PNG files, keyed by slot. A File used
 * in two slots shares one copy. Copies prepare one at a time in reference order; a newer
 * cleaning revision seen by any of them prepares every older copy again, after their
 * deletions settle. Construct it while a component initializes.
 */
export class LocalCopies {
	#watch: CleaningWatch;
	#slots: SlotFiles<LocalCopy>;
	/** File slots in reference order, with their 1-based position and copy. */
	files = $state.raw<readonly { position: number; key: number; copy: LocalCopy }[]>([]);
	#checking = false;

	constructor(
		source: () => readonly (SlotFile | null)[] | null,
		cleaning: () => CleaningSetting | null = () => null,
	) {
		this.#watch = new CleaningWatch(cleaning);
		const pool: Pool = { watch: this.#watch, turn: oneAtATime(), deletes: new PendingDeletes() };
		this.#slots = new SlotFiles(
			(file) => new LocalCopy(file, pool),
			(copy) => copy.dispose(),
		);
		this.#watch.onNewer = () => this.#replaceOutdated();
		$effect(() => {
			const references = source() ?? [];
			untrack(() => {
				this.#slots.sync(references);
				this.files = this.#slots.files;
			});
		});
		$effect(() => () => {
			this.#slots.clear();
			this.files = [];
		});
		// A reload or closed tab never unmounts the component. A page restored from
		// the back-forward cache prepares its files again.
		$effect(() => {
			const hide = () => {
				for (const copy of this.#copies()) copy.suspend();
			};
			const show = (event: PageTransitionEvent) => {
				if (event.persisted) for (const copy of this.#copies()) copy.resume();
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

	/** Whether attached files are (or will be) cleaned under the current setting. */
	get cleaned() {
		return this.#watch.setting?.enabled ?? true;
	}

	/** The copy of the file in the slot with `key`. */
	forSlot(key: number) {
		return this.files.find((slot) => slot.key === key)?.copy ?? null;
	}

	/** The copy at a 1-based reference position. */
	at(position: number) {
		return this.files.find((slot) => slot.position === position)?.copy ?? null;
	}

	/** Positions that share an attached file or a staged digest. */
	duplicates() {
		return duplicatePositions(this.files, (copy) => copy.stage?.digest);
	}

	/**
	 * Prepare the copies at these positions again, in reference order, without Try again,
	 * because a Review or Queue found them stale. The setting may have changed since, so it
	 * is read once for all of them.
	 */
	renew(positions: readonly number[]) {
		const copies = new Set(positions.map((position) => this.at(position)));
		void this.#watch.read().catch(() => {});
		for (const copy of this.#copies()) if (copies.has(copy)) copy.replace();
	}

	#copies() {
		return [...new Set(this.files.map(({ copy }) => copy))];
	}

	#replaceOutdated() {
		for (const copy of this.#copies()) if (copy.outdated) copy.replace();
	}

	// When the tab is shown again, ask whether the setting changed since the files'
	// preparations were admitted. Only a change reloads the page data and prepares again.
	async #checkSetting() {
		if (!this.files.length || this.#checking) return;
		this.#checking = true;
		try {
			const page = this.#watch.pageRevision;
			// A newer revision already prepares every older copy again (see `onNewer`).
			const current = await this.#watch.read();
			if (current !== null && current !== page) await invalidateAll();
			this.#replaceOutdated();
		} catch {
			// The next visibility change or a stale Review asks again.
		} finally {
			this.#checking = false;
		}
	}
}
