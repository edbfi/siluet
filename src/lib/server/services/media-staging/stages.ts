import { createHash } from "node:crypto";
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
export type StageScope = { owner: string; session: string; draft: string };
type Stage = {
	scope: StageScope;
	descriptor: MediaDescriptor;
	path: string;
	expiry: ReturnType<typeof setTimeout>;
	readers: ReturnType<typeof stageReaders>;
	reservation: ScratchReservation;
	consumed?: boolean;
	boundary?: Promise<boolean>;
	claim?: Promise<void>;
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
	const writes = new Set<{ session: string; retired: boolean }>();
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
				// Windows refuses to delete a file with an open handle. Retry, then keep it charged.
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
	function timer(handle: string) {
		return setTimeout(() => {
			void serialize(async () => {
				const s = stages.get(handle);
				if (s && s.descriptor.deadline <= now()) await remove(s);
			}).catch(() => {});
		}, stageIdleMs).unref();
	}
	function live(stage: Stage) {
		return (
			!closed &&
			!stage.consumed &&
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
	async function review<D extends MediaDescriptor>(
		scope: StageScope,
		handle: string,
		expected: D,
	): Promise<D | null>;
	async function review(scope: StageScope, handle: string): Promise<MediaDescriptor | null>;
	async function review(scope: StageScope, handle: string, expected?: MediaDescriptor) {
		return serialize(async () => {
			const stage = stages.get(handle);
			if (
				!stage ||
				!same(stage.scope, scope) ||
				!live(stage) ||
				(expected && !matches(stage.descriptor, expected))
			)
				return null;
			clearTimeout(stage.expiry);
			stage.descriptor.deadline = now() + stageIdleMs;
			stage.expiry = timer(handle);
			return { ...stage.descriptor };
		});
	}
	type Commit = (
		live: () => boolean,
		durable: (write: () => Promise<boolean>) => Promise<boolean>,
	) => Promise<boolean>;
	async function claim(scope: StageScope, descriptor: MediaDescriptor, commit: Commit) {
		const stage = await find(scope, descriptor.handle);
		if (!stage) return null;
		const valid = () =>
			live(stage) && descriptor.deadline > now() && matches(stage.descriptor, descriptor);
		while (stage.claim && valid()) await stage.claim;
		if (!valid()) return null;
		if (buffers + descriptor.size > bufferLimit) throw new StageError("Upload busy · nothing sent");
		buffers += descriptor.size;
		// The buffer stays charged until the read settles and the bytes are released,
		// even when the stage is retired while the read is in flight.
		const bytes = new Uint8Array(descriptor.size);
		let released = false,
			committed = false;
		const finished = Promise.withResolvers<void>();
		const release = () => {
			if (released) return;
			released = true;
			if (bytes.byteLength) bytes.buffer.transfer(0);
			buffers -= descriptor.size;
		};
		stage.claim = finished.promise;
		const durable = async (write: () => Promise<boolean>) => {
			if (!valid() || released || stage.boundary || committed) return false;
			// Called after acquiring the database connection. No stage-store mutex
			// is held while the transaction waits on the storage engine.
			stage.boundary = Promise.resolve()
				.then(write)
				.then((won) => {
					committed = won;
					stage.consumed = won;
					return won;
				});
			try {
				return await stage.boundary;
			} finally {
				stage.boundary = undefined;
				if (committed) void serialize(() => remove(stage)).catch(() => {});
			}
		};
		try {
			await read(stage, bytes);
			if (!valid()) return null;
			const success = await commit(valid, durable);
			if (!committed && success && valid() && !released) committed = true;
			if (!committed) return null;
			// Removal must preserve committed transfer bytes and be final even on an unlink failure.
			await serialize(() => remove(stage)).catch(() => {});
			return { bytes, release };
		} catch (error) {
			if (stage.readers.signal.aborted && !(error instanceof ChangedStage)) return null;
			throw error;
		} finally {
			if (!committed) release();
			if (stage.claim === finished.promise) stage.claim = undefined;
			finished.resolve();
		}
	}
	type PutOptions = {
		valid?: () => Promise<boolean>;
		/** The preparation's deadline, request and shutdown. Nothing publishes once it aborts. */
		signal?: AbortSignal;
	};
	function put<P extends StageProfile>(
		scope: StageScope,
		media: PreparedStageMedia<P>,
		options?: PutOptions,
	): Promise<MediaDescriptor<P>>;
	function put(
		scope: StageScope,
		media: PreparedStageMedia,
		{ valid = async () => true, signal }: PutOptions = {},
	) {
		const write = { session: scope.session, retired: false };
		const stopped = () => closed || write.retired || !!signal?.aborted;
		writes.add(write);
		return serialize(async () => {
			if (stopped() || !(await valid())) throw new StageError("Stage unavailable.");
			await sweep();
			for (const s of stages.values()) if (!live(s)) await remove(s);
			const { bytes, digest, size } = media;
			const profile: StageProfile =
				media.mime === "image/jpeg"
					? { mime: media.mime, transform: media.transform }
					: { mime: media.mime, transform: "none" };
			if (bytes.length !== size || !size || size > maxStageBytes) throw new ChangedStage();
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
	function retireSessions(digests: ReadonlySet<string>) {
		for (const write of writes) if (digests.has(write.session)) write.retired = true;
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
		discard(scope: StageScope, handle: string) {
			return serialize(async () => {
				const stage = stages.get(handle);
				if (stage && same(stage.scope, scope)) await remove(stage);
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
