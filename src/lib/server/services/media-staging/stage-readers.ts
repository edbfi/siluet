import type { BigIntStats } from "node:fs";
import { constants } from "node:fs";
import { type FileHandle, open } from "node:fs/promises";
export class StageError extends Error {}
export class ChangedStage extends StageError {
	constructor() {
		super("Staged file changed.");
	}
}
const openStage = (path: string) => open(path, constants.O_RDONLY | constants.O_NOFOLLOW);

// A lease pins the opened inode. Revocation waits for opens already in flight, and
// each reader closes its file only after its own reads and checks settle, before
// the stage returns its disk reservation.
export function stageReaders(
	path: string,
	identity: BigIntStats,
	changed: () => void,
	openFile: (path: string) => Promise<FileHandle> = openStage,
) {
	const controller = new AbortController();
	const handles = new Set<() => Promise<void>>();
	const opening = new Set<Promise<unknown>>();
	const signal = controller.signal;
	async function acquire() {
		signal.throwIfAborted();
		let file: FileHandle;
		try {
			file = await openFile(path);
		} catch (error) {
			if (
				error instanceof Error &&
				"code" in error &&
				["ENOENT", "ELOOP"].includes(String(error.code))
			)
				throw new ChangedStage();
			throw error;
		}
		// Reads and stats in flight on this file. Closing waits for them.
		const active = new Set<Promise<unknown>>();
		const track = <T>(work: Promise<T>) => {
			active.add(work);
			void work.then(
				() => active.delete(work),
				() => active.delete(work),
			);
			return work;
		};
		let closing: Promise<void> | undefined;
		const close = () => {
			closing ??= (async () => {
				// A settled read can start its identity check, so wait until none remain.
				while (active.size) await Promise.allSettled(active);
				await file.close();
			})().finally(() => handles.delete(close));
			return closing;
		};
		handles.add(close);
		async function verify() {
			const current = await track(file.stat({ bigint: true }));
			if (
				!current.isFile() ||
				current.dev !== identity.dev ||
				current.ino !== identity.ino ||
				current.ctimeNs !== identity.ctimeNs ||
				current.mtimeNs !== identity.mtimeNs ||
				current.size !== identity.size
			)
				throw new ChangedStage();
		}
		try {
			await verify();
			signal.throwIfAborted();
			return {
				close,
				read: async (bytes: Uint8Array, offset: number, length: number, position: number) => {
					signal.throwIfAborted();
					if (closing) throw new StageError("Reader closed.");
					const result = await track(file.read(bytes, offset, length, position));
					try {
						await verify();
					} catch (error) {
						if (error instanceof ChangedStage) changed();
						throw error;
					}
					signal.throwIfAborted();
					return result;
				},
			};
		} catch (error) {
			await close();
			throw error;
		}
	}
	return {
		signal,
		abort: () => controller.abort(),
		open() {
			const pending = acquire();
			opening.add(pending);
			return pending.finally(() => opening.delete(pending));
		},
		/** Abort, then close every reader. Never rejects: a failed close leaves removal to retry. */
		async retire() {
			controller.abort();
			await Promise.allSettled(opening);
			await Promise.allSettled([...handles].map((close) => close()));
		},
	};
}
