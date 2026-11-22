import type { BigIntStats } from "node:fs";
import { constants } from "node:fs";
import { type FileHandle, open } from "node:fs/promises";
export class StageError extends Error {}
export class ChangedStage extends StageError {
	constructor() {
		super("Staged file changed.");
	}
}
// A lease pins the opened inode. Revocation waits for opens already in flight
// as well as closing each reader before the stage returns its disk reservation.
export function stageReaders(path: string, identity: BigIntStats, changed: () => void) {
	const controller = new AbortController();
	const handles = new Set<() => Promise<void>>();
	const opening = new Set<Promise<unknown>>();
	const signal = controller.signal;
	async function acquire() {
		signal.throwIfAborted();
		let file: FileHandle;
		try {
			file = await open(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
		} catch (error) {
			if (
				error instanceof Error &&
				"code" in error &&
				["ENOENT", "ELOOP"].includes(String(error.code))
			)
				throw new ChangedStage();
			throw error;
		}
		let closing: Promise<void> | undefined;
		const close = () => {
			closing ??= file.close().finally(() => handles.delete(close));
			return closing;
		};
		handles.add(close);
		async function verify() {
			const current = await file.stat({ bigint: true });
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
					const result = await file.read(bytes, offset, length, position);
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
		async retire() {
			controller.abort();
			await Promise.allSettled(opening);
			await Promise.all([...handles].map((close) => close()));
		},
	};
}
