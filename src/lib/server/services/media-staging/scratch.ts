import { mkdir, rm } from "node:fs/promises";
import { join } from "node:path";
import { isRuntimeInstallation, type RuntimeInstallation } from "../../db/runtime-installation";

export const scratchPoolBytes = 128 * 1024 * 1024;
export const scratchFullMessage =
	"Local scratch full. Remove a staged file or wait for idle expiry.";

export class ScratchFull extends Error {
	constructor() {
		super(scratchFullMessage);
		this.name = "ScratchFull";
	}
}

export type ScratchReservation = {
	/** Shrink the reservation to the bytes actually written. */
	commit(actual: number): void;
	/** Return the space after its file is gone. Repeated calls are ignored. */
	release(): void;
};
export type ScratchScope = {
	readonly directory: string;
	reserve(upperBound: number): ScratchReservation;
};

/**
 * One private scratch budget per installation. Each media kind stages under
 * `<data>/scratch/<kind>/` and reserves an upper bound before writing.
 */
export function createScratchPool(
	installation: RuntimeInstallation,
	{
		bytes = scratchPoolBytes,
		retryDelays = [50, 250, 1000],
		removeTree = (path: string) => rm(path, { recursive: true, force: true }),
	}: {
		bytes?: number;
		retryDelays?: readonly number[];
		removeTree?: (path: string) => Promise<void>;
	} = {},
) {
	const root = join(installation.directory, "scratch");
	let used = 0;
	let reclaimed = false;
	function reserve(upperBound: number): ScratchReservation {
		if (!Number.isSafeInteger(upperBound) || upperBound < 1) throw new RangeError("Invalid size.");
		if (used + upperBound > bytes) throw new ScratchFull();
		used += upperBound;
		let held = upperBound;
		return {
			commit(actual) {
				if (!Number.isSafeInteger(actual) || actual < 0 || actual > held)
					throw new RangeError("Invalid size.");
				used -= held - actual;
				held = actual;
			},
			release() {
				used -= held;
				held = 0;
			},
		};
	}
	return {
		get used() {
			return used;
		},
		/**
		 * Delete leftovers from an earlier process. Only a runtime that holds the process
		 * registry entry and Turso's lock may do this, before any scope is used.
		 */
		async reclaim() {
			if (!isRuntimeInstallation(installation))
				throw new Error("Scratch reclaim requires the runtime installation lock.");
			if (reclaimed || used) throw new Error("Scratch is already in use.");
			// Windows refuses to delete a file another process holds open. Retry as unlink does.
			let failure: unknown;
			for (const delay of [0, ...retryDelays]) {
				if (delay) await Bun.sleep(delay);
				try {
					await removeTree(root);
					failure = undefined;
					break;
				} catch (error) {
					failure = error;
				}
			}
			if (failure)
				throw new Error(
					"Unable to clear Siluet's scratch directory from an earlier run. Close any program using files in its data directory's scratch folder, then start Siluet again.",
					{ cause: failure },
				);
			await mkdir(root, { mode: 0o700 });
			reclaimed = true;
		},
		async scope(kind: string): Promise<ScratchScope> {
			if (!/^[a-z]+$/.test(kind)) throw new Error("Invalid scratch kind.");
			if (!reclaimed) throw new Error("Reclaim scratch before use.");
			const directory = join(root, kind);
			await mkdir(directory, { recursive: true, mode: 0o700 });
			return { directory, reserve };
		},
	};
}
export type ScratchPool = ReturnType<typeof createScratchPool>;
