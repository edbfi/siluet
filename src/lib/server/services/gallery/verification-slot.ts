/**
 * One image verification at a time (D5): a 20 MP decode is Save's largest memory cost, so two
 * transfers may overlap but their decodes take turns, oldest first. A caller still waiting
 * leaves at once when its signal aborts; a running verification finishes.
 */
export function createVerificationSlot() {
	let busy = false;
	const waiting: (() => void)[] = [];

	function take(signal: AbortSignal) {
		signal.throwIfAborted();
		if (!busy) {
			busy = true;
			return Promise.resolve();
		}
		return new Promise<void>((resolve, reject) => {
			const turn = () => {
				signal.removeEventListener("abort", abort);
				resolve();
			};
			const abort = () => {
				waiting.splice(waiting.indexOf(turn), 1);
				reject(signal.reason);
			};
			waiting.push(turn);
			signal.addEventListener("abort", abort, { once: true });
		});
	}

	return async function verifyInTurn<T>(signal: AbortSignal, work: () => Promise<T>) {
		await take(signal);
		try {
			return await work();
		} finally {
			// Hand the slot straight to the next caller, so a new one cannot overtake it.
			const next = waiting.shift();
			if (next) next();
			else busy = false;
		}
	};
}
