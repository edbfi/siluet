import type { Plugin } from "vite";

/**
 * The client's JavaScript and CSS budget. Recorded on 2026-11-26 at 442,350 bytes, before any
 * page imports the derived catalog rows (`poyo-rows.json`, about 179 KB). A slice that ships
 * them to the browser raises this number on purpose, with its measured size. The picker ships
 * only their projection (`poyo-picker.json`, about 26 KB): 473,118 bytes on 2026-11-27. After the
 * `ec73207` re-pin added nine picker rows (`poyo-picker.json` now about 27 KB), the client
 * measured 474,600 bytes the same day. With the derived text-to-image composer and its queue rows
 * (`poyo-queue.json`, about 13 KB) it measured 511,123 bytes on 2026-11-27.
 */
export const clientBudgetBytes = 512 * 1024;

type Output =
	| { type: "chunk"; code: string; moduleIds?: readonly string[] }
	| { type: "asset"; source: string | Uint8Array };

/** Generated projections only the server reads. The browser must never bundle them. */
const serverOnly = ["src/lib/server/providers/poyo/queue-schemas.json"];

/** The bytes of JavaScript and CSS one client bundle emits. */
export function clientBytes(bundle: Record<string, Output>) {
	let total = 0;
	for (const [name, output] of Object.entries(bundle)) {
		if (!/\.(m?js|css)$/.test(name)) continue;
		total +=
			output.type === "chunk"
				? Buffer.byteLength(output.code)
				: typeof output.source === "string"
					? Buffer.byteLength(output.source)
					: output.source.byteLength;
	}
	return total;
}

/** Fails the client build when its JavaScript and CSS exceed the recorded budget. */
export function clientBudget(budget = clientBudgetBytes): Plugin {
	return {
		name: "siluet-client-budget",
		apply: "build",
		generateBundle(_options, bundle) {
			if (this.environment?.name !== "client") return;
			const outputs = Object.values(bundle as unknown as Record<string, Output>);
			for (const output of outputs)
				for (const id of output.type === "chunk" ? (output.moduleIds ?? []) : [])
					for (const path of serverOnly)
						if (id.endsWith(`/${path}`))
							this.error(`The client bundle includes the server-only ${path}.`);
			const total = clientBytes(bundle as unknown as Record<string, Output>);
			if (total > budget)
				this.error(`The client bundle is ${total} bytes, over its ${budget}-byte budget.`);
		},
	};
}
