import { createHash } from "node:crypto";
import type { BigIntStats } from "node:fs";
import { rm, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type {
	MediaDescriptor,
	PreparedStageMedia,
	StageProfile,
} from "../../../shared/media-staging/descriptor";
import { ScratchFull, type ScratchReservation, type ScratchScope } from "./scratch";
import { ChangedStage, StageError, stageReaders } from "./stage-readers";

export { StageError };

/** The cleaning setting changed after this copy was prepared (D10). */
export class CleaningChangedError extends Error {
	constructor() {
		super("The cleaning setting changed.");
		this.name = "CleaningChangedError";
	}
}
/** What a stage's server record adds to its descriptor. Never sent to the browser. */
export type StageMode = { revision: number; rotated: boolean };
export type StageScope = { owner: string; session: string; draft: string };
/** The signed-in owner and session. Each staged file carries its own draft. */
export type OwnerScope = Omit<StageScope, "draft">;
type Commit = (
	live: () => boolean,
	durable: (write: () => Promise<boolean>) => Promise<boolean>,
	stages: StageMode[],
) => Promise<boolean>;
/** Claimed stages, detached from the store: only their dispatcher reads or removes them. */
export type ClaimHandle = {
	/** The verified bytes of the stage at `index`, valid until the next call or release. */
	next(index: number): Promise<Uint8Array<ArrayBuffer>>;
	/** Free the buffer, any reservation, and every stage not yet read. */
	release(): Promise<void>;
};
export type ClaimResult =
	| { held: ClaimHandle }
	/** Indexes whose stages are missing, expired, changed or retired. */
	| { stale: number[] }
	/** The commit refused for its own reasons; every stage stays staged. */
	| { refused: true }
	/** An identical claim held these stages. Look up its job before admitting again. */
	| { joined: true };
type Stage = {
	scope: StageScope;
	descriptor: MediaDescriptor;
	path: string;
	expiry: ReturnType<typeof setTimeout>;
	readers: ReturnType<typeof stageReaders>;
	/** The written file's identity, checked again by the dispatcher's own reader. */
	identity: BigIntStats;
	reservation: ScratchReservation;
	/** The cleaning setting's revision this copy was prepared under. */
	revision: number;
	/** An original declares a rotation. */
	rotated: boolean;
	consumed?: boolean;
	boundary?: Promise<boolean>;
	/** The binding of the claim that holds this stage, and when that claim settles. */
	holder?: { binding: string; settled: Promise<void> };
};
export const stageIdleMs = 15 * 60_000;
// The staging transport limit. Qualified cleaners apply lower per-format limits.
export const maxStageBytes = 32_000_000;
const same = (a: StageScope, b: StageScope) =>
	a.session === b.session && a.owner === b.owner && a.draft === b.draft;
function matches(a: MediaDescriptor, b: MediaDescriptor) {
	return Object.keys(a).every((k) => k === "deadline" || Reflect.get(a, k) === Reflect.get(b, k));
}

export type StageOptions = {
	now?: () => number;
	/** The clock a preparation deadline is measured on. */
	monotonic?: () => number;
	/** Aggregate in-memory dispatch buffers, separate from the scratch pool. */
	buffers?: number;
	retryDelays?: readonly number[];
	removeFile?: (path: string) => Promise<void>;
	/** Test seam for the exclusive private write of a new stage file. */
	writeFile?: (path: string, bytes: Uint8Array) => Promise<void>;
	/** Test seam awaited between chunks of a dispatch read. */
	pace?: () => Promise<void>;
};

export function createStages(
	scratch: ScratchScope,
	{
		now = Date.now,
		monotonic = () => performance.now(),
		buffers: bufferLimit = 32_000_000,
		retryDelays = [50, 250, 1000],
		removeFile = (path) => rm(path, { force: true }),
		writeFile: writeStage = (path, bytes) => writeFile(path, bytes, { flag: "wx", mode: 0o600 }),
		pace,
	}: StageOptions = {},
) {
	const stages = new Map<string, Stage>();
	// Files whose unlink failed stay charged until a later sweep removes them.
	const leftovers = new Map<string, ScratchReservation>();
	const writes = new Set<{ scope: StageScope; retired: boolean; revision: number }>();
	// The lowest cleaning revision a stage may have. Only ever raised.
	let generation = 0;
	// Drafts the browser discarded, until any write it abandoned could no longer arrive.
	const discarded = new Map<string, number>();
	const draftKey = ({ owner, session, draft }: StageScope) => `${owner}\n${session}\n${draft}`;
	function wasDiscarded(scope: StageScope) {
		for (const [key, until] of discarded) if (until <= now()) discarded.delete(key);
		return discarded.has(draftKey(scope));
	}
	let buffers = 0,
		closed = false,
		tail = Promise.resolve();
	function serialize<T>(work: () => Promise<T>) {
		const result = tail.then(work);
		tail = result.then(
			() => {},
			() => {},
		);
		return result;
	}
	async function unlink(path: string, reservation: ScratchReservation, delays = retryDelays) {
		for (const delay of [0, ...delays]) {
			if (delay) await Bun.sleep(delay);
			try {
				await removeFile(path);
				leftovers.delete(path);
				reservation.release();
				return true;
			} catch {
				// Retry a transient removal failure such as EIO, then keep it charged.
			}
		}
		leftovers.set(path, reservation);
		return false;
	}
	async function sweep() {
		for (const [path, reservation] of leftovers) await unlink(path, reservation, []);
	}
	async function remove(stage: Stage) {
		if (stage.boundary) await stage.boundary.catch(() => false);
		if (!stages.delete(stage.descriptor.handle)) return;
		clearTimeout(stage.expiry);
		try {
			await stage.readers.retire();
		} finally {
			// A failed unlink stays charged in leftovers for the next sweep.
			await unlink(stage.path, stage.reservation);
		}
	}
	function timer(handle: string, delay = stageIdleMs): ReturnType<typeof setTimeout> {
		const expiry = setTimeout(() => {
			void serialize(async () => {
				const s = stages.get(handle);
				if (!s || s.expiry !== expiry) return;
				const remaining = s.descriptor.deadline - now();
				if (remaining <= 0) await remove(s);
				// The wall clock stepped back: wait out the rest, at most one idle period at a time.
				else s.expiry = timer(handle, Math.min(remaining, stageIdleMs));
			}).catch(() => {});
		}, delay).unref();
		return expiry;
	}
	function live(stage: Stage) {
		return (
			!closed &&
			!stage.consumed &&
			stage.revision >= generation &&
			!stage.readers.signal.aborted &&
			stages.get(stage.descriptor.handle) === stage &&
			stage.descriptor.deadline > now()
		);
	}
	async function find(scope: StageScope, handle: string) {
		const stage = stages.get(handle);
		if (!stage || !same(scope, stage.scope)) return null;
		if (!live(stage)) {
			await serialize(() => remove(stage));
			return null;
		}
		return stage;
	}
	async function openReader(stage: Stage) {
		try {
			return await stage.readers.open();
		} catch (error) {
			if (error instanceof ChangedStage) await serialize(() => remove(stage));
			throw error;
		}
	}
	async function read(stage: Stage, bytes: Uint8Array) {
		const handle = await openReader(stage);
		try {
			let offset = 0;
			while (offset < bytes.length) {
				await pace?.();
				const { bytesRead } = await handle.read(
					bytes,
					offset,
					Math.min(65536, bytes.length - offset),
					offset,
				);
				if (!bytesRead) throw new ChangedStage();
				offset += bytesRead;
			}
			if (createHash("sha256").update(bytes).digest("hex") !== stage.descriptor.digest)
				throw new ChangedStage();
			return bytes;
		} catch (error) {
			if (error instanceof ChangedStage) await serialize(() => remove(stage));
			throw error;
		} finally {
			await handle.close();
		}
	}
	/** A claimed stage is read through a fresh reader that checks the written file's identity. */
	async function readDetached(stage: Stage, bytes: Uint8Array) {
		const readers = stageReaders(stage.path, stage.identity, () => {});
		const handle = await readers.open();
		try {
			let offset = 0;
			while (offset < bytes.length) {
				await pace?.();
				const { bytesRead } = await handle.read(
					bytes,
					offset,
					Math.min(65536, bytes.length - offset),
					offset,
				);
				if (!bytesRead) throw new ChangedStage();
				offset += bytesRead;
			}
			if (createHash("sha256").update(bytes).digest("hex") !== stage.descriptor.digest)
				throw new ChangedStage();
		} finally {
			await readers.retire();
		}
	}
	type Reviewed<D> = { descriptor: D } & StageMode;
	const scoped = (scope: OwnerScope, d: Pick<MediaDescriptor, "draft">) => ({
		...scope,
		draft: d.draft,
	});
	/**
	 * Check every stage (live, unclaimed, unchanged, in its own draft and, when given,
	 * prepared under `revision`) before extending any deadline. A stale stage extends
	 * nothing and answers with the indexes to prepare again.
	 */
	function reviewAll<D extends MediaDescriptor>(
		scope: OwnerScope,
		expected: readonly D[],
		revision?: number,
	): Promise<{ reviewed: Reviewed<D>[] } | { stale: number[] }> {
		return serialize(async () => {
			const found = expected.map((d) => {
				const stage = stages.get(d.handle);
				return stage &&
					same(stage.scope, scoped(scope, d)) &&
					live(stage) &&
					!stage.holder &&
					matches(stage.descriptor, d) &&
					(revision === undefined || stage.revision === revision)
					? stage
					: null;
			});
			const stale = found.flatMap((stage, index) => (stage ? [] : [index]));
			if (stale.length) return { stale };
			const deadline = now() + stageIdleMs;
			return {
				reviewed: (found as Stage[]).map((stage) => {
					clearTimeout(stage.expiry);
					stage.descriptor.deadline = deadline;
					stage.expiry = timer(stage.descriptor.handle);
					return {
						descriptor: { ...stage.descriptor } as D,
						revision: stage.revision,
						rotated: stage.rotated,
					};
				}),
			};
		});
	}
	/** One stage's Review: `reviewAll` with that stage, or its current descriptor. */
	async function review<D extends MediaDescriptor>(
		scope: StageScope,
		handle: string,
		expected?: D,
	): Promise<Reviewed<D> | null> {
		const current = stages.get(handle)?.descriptor;
		const descriptor = expected ?? (current as D | undefined);
		if (!descriptor || descriptor.handle !== handle || descriptor.draft !== scope.draft)
			return null;
		const result = await reviewAll(scope, [descriptor]);
		return "reviewed" in result ? result.reviewed[0] : null;
	}
	const modeOf = (stage: Stage): StageMode => ({
		revision: stage.revision,
		rotated: stage.rotated,
	});
	/**
	 * Claim every stage for one durable job, or none. Every handle is checked and marked
	 * synchronously: a distinct holder is busy, an identical binding joins it. One buffer of
	 * the largest size is charged, every digest is verified before the commit, the first file
	 * last so the buffer keeps its snapshot, and the commit detaches every stage from the
	 * store so no sweep, publish, flip, sign-out, discard or close can remove it. Previews
	 * end at the claim.
	 */
	async function claimAll(
		scope: OwnerScope,
		descriptors: readonly MediaDescriptor[],
		binding: string,
		commit: Commit,
		reserve: () => (() => void) | null = () => () => {},
	): Promise<ClaimResult> {
		const held = descriptors.map((d) => stages.get(d.handle));
		const valid = (index: number) => {
			const stage = held[index];
			const d = descriptors[index];
			return (
				!!stage &&
				same(stage.scope, scoped(scope, d)) &&
				live(stage) &&
				d.deadline > now() &&
				matches(stage.descriptor, d)
			);
		};
		const invalid = () => descriptors.flatMap((_, index) => (valid(index) ? [] : [index]));
		const holders = new Set(held.flatMap((stage) => (stage?.holder ? [stage.holder] : [])));
		if ([...holders].some((holder) => holder.binding !== binding))
			throw new StageError("Upload busy · nothing sent");
		if (holders.size) {
			await Promise.all([...holders].map((holder) => holder.settled));
			return { joined: true };
		}
		const stale = invalid();
		if (stale.length) return { stale };
		const claimed = held as Stage[];
		const size = Math.max(...descriptors.map((d) => d.size));
		if (buffers + size > bufferLimit) throw new StageError("Upload busy · nothing sent");
		const unreserve = reserve();
		if (!unreserve) throw new StageError("Upload busy · nothing sent");
		buffers += size;
		const settled = Promise.withResolvers<void>();
		const holder = { binding, settled: settled.promise };
		for (const stage of claimed) stage.holder = holder;
		// The buffer stays charged until every read settles and the bytes are released,
		// even when a stage is retired while its read is in flight.
		const bytes = new Uint8Array(size);
		let released = false,
			committed = false;
		const freeBuffer = () => {
			if (released) return;
			released = true;
			if (bytes.byteLength) bytes.buffer.transfer(0);
			buffers -= size;
			unreserve();
		};
		const allValid = () => !released && descriptors.every((_, index) => valid(index));
		const detach = () => {
			committed = true;
			for (const stage of claimed) {
				stage.consumed = true;
				stages.delete(stage.descriptor.handle);
				clearTimeout(stage.expiry);
			}
		};
		const durable = async (write: () => Promise<boolean>) => {
			if (!allValid() || committed || claimed.some((stage) => stage.boundary)) return false;
			// Called after acquiring the database connection. No stage-store mutex
			// is held while the transaction waits on the storage engine.
			const boundary = Promise.resolve()
				.then(write)
				.then((won) => {
					// Detach at once, before any remover waiting on the boundary resumes.
					if (won) detach();
					return won;
				});
			for (const stage of claimed) stage.boundary = boundary;
			try {
				return await boundary;
			} finally {
				for (const stage of claimed) stage.boundary = undefined;
			}
		};
		try {
			// The first stage last, so the buffer holds its verified snapshot at commit.
			for (const index of [...descriptors.keys()].slice(1).concat(0)) {
				await read(claimed[index], bytes.subarray(0, descriptors[index].size));
				if (!allValid()) return { stale: invalid() };
			}
			const success = await commit(allValid, durable, claimed.map(modeOf));
			if (!committed && success && allValid()) detach();
			if (!committed) {
				const after = invalid();
				return after.length ? { stale: after } : { refused: true };
			}
		} catch (error) {
			if (!committed) {
				const aborted = claimed.some((stage) => stage.readers.signal.aborted);
				if (aborted && !(error instanceof ChangedStage)) return { stale: invalid() };
			}
			throw error;
		} finally {
			for (const stage of claimed) if (stage.holder === holder) stage.holder = undefined;
			if (!committed) freeBuffer();
			settled.resolve();
		}
		// Previews end at the claim. The first stage's bytes are already in the buffer.
		await Promise.allSettled(claimed.map((stage) => stage.readers.retire()));
		const remaining = new Set(claimed.keys());
		const drop = async (index: number) => {
			if (!remaining.delete(index)) return;
			await unlink(claimed[index].path, claimed[index].reservation);
		};
		await drop(0);
		return {
			held: {
				async next(index) {
					const d = descriptors[index];
					if (released || !d) throw new StageError("Claim released.");
					const view = bytes.subarray(0, d.size);
					if (index === 0) return view;
					if (!remaining.has(index)) throw new StageError("Stage already read.");
					try {
						await readDetached(claimed[index], view);
						return view;
					} finally {
						await drop(index);
					}
				},
				async release() {
					freeBuffer();
					await Promise.all([...remaining].map(drop));
				},
			},
		};
	}
	/** One stage's claim: `claimAll` with that stage and a fresh binding. */
	async function claim(
		scope: StageScope,
		descriptor: MediaDescriptor,
		commit: (
			live: () => boolean,
			durable: (write: () => Promise<boolean>) => Promise<boolean>,
			stage: StageMode,
		) => Promise<boolean>,
	) {
		if (descriptor.draft !== scope.draft) return null;
		const result = await claimAll(
			scope,
			[descriptor],
			crypto.randomUUID(),
			(valid, durable, modes) => commit(valid, durable, modes[0]),
		);
		if (!("held" in result)) return null;
		const { held } = result;
		return { bytes: await held.next(0), release: () => void held.release() };
	}
	type PutOptions = {
		valid?: () => Promise<boolean>;
		/** The preparation's request, shutdown and timer. Nothing is written or published once it aborts. */
		signal?: AbortSignal;
		/** The preparation's monotonic deadline, checked even when its timer has not fired yet. */
		deadline?: number;
	};
	function put<P extends StageProfile>(
		scope: StageScope,
		media: PreparedStageMedia<P>,
		options?: PutOptions,
	): Promise<MediaDescriptor<P>>;
	function put(
		scope: StageScope,
		media: PreparedStageMedia,
		{ valid = async () => true, signal, deadline = Infinity }: PutOptions = {},
	) {
		const write = { scope: { ...scope }, retired: wasDiscarded(scope), revision: media.revision };
		// A flip is checked first, so close, abort, deadline and retirement keep their own error.
		const stopped = () => {
			if (write.revision < generation) throw new CleaningChangedError();
			return closed || write.retired || !!signal?.aborted || monotonic() >= deadline;
		};
		writes.add(write);
		return serialize(async () => {
			if (stopped() || !(await valid())) throw new StageError("Stage unavailable.");
			await sweep();
			for (const s of stages.values()) if (!live(s)) await remove(s);
			const { bytes, digest, size } = media;
			const profile: StageProfile =
				media.mime === "image/jpeg"
					? { mime: media.mime, transform: media.transform }
					: { mime: media.mime, transform: media.transform };
			if (bytes.length !== size || !size || size > maxStageBytes) throw new ChangedStage();
			// Checked again with no await before reserving and starting the write.
			if (stopped()) throw new StageError("Stage unavailable.");
			let reservation: ScratchReservation;
			try {
				// Reserve before writing so a full pool leaves no partial file.
				reservation = scratch.reserve(size);
			} catch (error) {
				if (error instanceof ScratchFull) throw new StageError(error.message);
				throw error;
			}
			const handle = crypto.randomUUID(),
				path = join(scratch.directory, handle);
			const descriptor = {
				...profile,
				digest,
				size,
				handle,
				draft: scope.draft,
				deadline: now() + stageIdleMs,
			} satisfies MediaDescriptor;
			try {
				await writeStage(path, bytes);
				reservation.commit(size);
				const info = await stat(path, { bigint: true });
				if (stopped() || !(await valid())) throw new StageError("Stage unavailable.");
				for (const s of stages.values()) if (same(s.scope, scope)) await remove(s);
				// Checked again with no await before publishing.
				if (stopped()) throw new StageError("Stage unavailable.");
				stages.set(handle, {
					scope: { ...scope },
					descriptor,
					path,
					reservation,
					revision: media.revision,
					rotated: media.rotated,
					identity: info,
					readers: stageReaders(path, info, () => {
						const current = stages.get(handle);
						if (current) void serialize(() => remove(current)).catch(() => {});
					}),
					expiry: timer(handle),
				});
				return { ...descriptor };
			} catch (error) {
				await unlink(path, reservation);
				throw error;
			}
		}).finally(() => writes.delete(write));
	}
	/**
	 * Retire every copy prepared before cleaning revision `revision`. Older readers stop
	 * at once; their files are removed in order. Writes in flight fail at publication.
	 */
	function retireAll(revision: number) {
		generation = Math.max(generation, revision);
		const floor = generation;
		for (const stage of stages.values()) if (stage.revision < floor) stage.readers.abort();
		return serialize(async () => {
			for (const stage of stages.values()) if (stage.revision < floor) await remove(stage);
		});
	}
	function retireSessions(digests: ReadonlySet<string>) {
		for (const write of writes) if (digests.has(write.scope.session)) write.retired = true;
		for (const stage of stages.values())
			if (digests.has(stage.scope.session)) stage.readers.abort();
		return serialize(async () => {
			for (const stage of stages.values())
				if (digests.has(stage.scope.session)) await remove(stage);
		});
	}
	return {
		retireSessions(digests: ReadonlySet<string>) {
			void retireSessions(digests).catch(() => {});
		},
		/** Bytes currently reserved for dispatch buffers. */
		get buffered() {
			return buffers;
		},
		put,
		review,
		reviewAll,
		retireAll,
		async openPreview(scope: StageScope, handle: string) {
			const stage = await find(scope, handle);
			if (!stage) return null;
			const reader = await openReader(stage);
			if (!live(stage)) {
				await reader.close();
				return null;
			}
			return {
				handle: reader,
				size: stage.descriptor.size,
				mime: stage.descriptor.mime,
				signal: stage.readers.signal,
			};
		},
		async preview(scope: StageScope, handle: string) {
			const stage = await find(scope, handle);
			if (!stage) return null;
			return {
				bytes: await read(stage, new Uint8Array(stage.descriptor.size)),
				mime: stage.descriptor.mime,
			};
		},
		claim,
		claimAll,
		/**
		 * Remove every copy of this draft, including one a request the browser
		 * abandoned has just written, and refuse later writes to the draft.
		 */
		discardDraft(scope: StageScope) {
			wasDiscarded(scope);
			discarded.set(draftKey(scope), now() + stageIdleMs);
			for (const write of writes) if (same(write.scope, scope)) write.retired = true;
			return serialize(async () => {
				for (const stage of stages.values()) if (same(stage.scope, scope)) await remove(stage);
			});
		},
		revoke(session: string) {
			return retireSessions(new Set([session]));
		},
		close() {
			closed = true;
			// Stop open previews now rather than after queued writes and unlink retries.
			for (const stage of stages.values()) stage.readers.abort();
			return serialize(async () => {
				for (const s of stages.values()) await remove(s);
				await sweep();
			});
		},
	};
}
export type FileStages = ReturnType<typeof createStages>;
