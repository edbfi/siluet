/**
 * The one Poyo.ai upload sequence an installation's file queue runs at a time, so the
 * window allowance checked at claim stays available to that job's later slots. A claim
 * takes it synchronously; every path that ends the claim or its uploads releases it.
 */
export function uploadSlot() {
	let holder: object | null = null;
	return {
		take() {
			if (holder) return null;
			const mine = {};
			holder = mine;
			return () => {
				if (holder === mine) holder = null;
			};
		},
	};
}
