/**
 * A fixed number of slots that callers take in arrival order (D5): Save verifies one image at a
 * time, and the Gallery route holds at most two image buffers. A caller still waiting leaves at
 * once when its signal aborts; a holder keeps its slot until it releases it.
 */
export function createSlots(count: number) {
	let free = count;
	const waiting: (() => void)[] = [];

	function releaser() {
		let released = false;
		return () => {
			if (released) return;
			released = true;
			// Hand the slot straight to the next caller, so a new one cannot overtake it.
			const next = waiting.shift();
			if (next) next();
			else free++;
		};
	}

	/** Wait for a slot; resolves with its release, which only the first call performs. */
	function take(signal: AbortSignal) {
		signal.throwIfAborted();
		if (free > 0) {
			free--;
			return Promise.resolve(releaser());
		}
		return new Promise<() => void>((resolve, reject) => {
			const turn = () => {
				signal.removeEventListener("abort", abort);
				resolve(releaser());
			};
			const abort = () => {
				waiting.splice(waiting.indexOf(turn), 1);
				reject(signal.reason);
			};
			waiting.push(turn);
			signal.addEventListener("abort", abort, { once: true });
		});
	}

	return {
		take,
		/**
		 * Run `work` in a slot, releasing it however `work` ends. A slot handed over after
		 * `signal` aborted is released at once, and `work` never runs.
		 */
		async run<T>(signal: AbortSignal, work: () => Promise<T>) {
			signal.throwIfAborted();
			const release = await take(signal);
			try {
				signal.throwIfAborted();
				return await work();
			} finally {
				release();
			}
		},
		/** Slots taken now. */
		held: () => count - free,
	};
}
