import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { clientBudget, clientBudgetBytes, clientBytes } from "./bundle-budget";

const bundle = {
	"_app/immutable/entry/app.js": { type: "chunk", code: "x".repeat(300) },
	"_app/immutable/assets/app.css": { type: "asset", source: "y".repeat(200) },
	"_app/immutable/assets/logo.svg": { type: "asset", source: new Uint8Array(5000) },
	"_app/version.json": { type: "asset", source: "{}" },
} as const;

test("only JavaScript and CSS count toward the client budget", () => {
	expect(clientBytes(bundle)).toBe(500);
});

function run(budget: number, environment: string, output: object = bundle) {
	const plugin = clientBudget(budget);
	const errors: string[] = [];
	const hook = plugin.generateBundle as (this: unknown, options: unknown, bundle: unknown) => void;
	hook.call(
		{
			environment: { name: environment },
			error: (message: string) => {
				errors.push(message);
				throw new Error(message);
			},
		},
		{},
		output,
	);
	return errors;
}

test("a client bundle over its budget fails the build; the server bundle is not counted", () => {
	expect(run(500, "client")).toEqual([]);
	expect(() => run(499, "client")).toThrow(
		"The client bundle is 500 bytes, over its 499-byte budget.",
	);
	expect(run(1, "ssr")).toEqual([]);
});

test("the derived rows would exceed the client budget, which the build enforces", () => {
	expect(clientBudgetBytes).toBe(524_288);
	const rows = readFileSync(
		new URL("../src/lib/shared/media-catalog/poyo-rows.json", import.meta.url),
	);
	expect(442_350 + rows.byteLength).toBeGreaterThan(clientBudgetBytes);
	expect(readFileSync(new URL("../vite.config.ts", import.meta.url), "utf8")).toContain(
		"clientBudget()",
	);
});

test("a client chunk that bundles a server-only projection fails the build", () => {
	const leaked = {
		...bundle,
		"_app/immutable/chunks/queue.js": {
			type: "chunk",
			code: "x",
			moduleIds: ["/repo/src/lib/server/providers/poyo/queue-schemas.json"],
		},
	};
	expect(() => run(10_000, "client", leaked)).toThrow(
		"The client bundle includes the server-only src/lib/server/providers/poyo/queue-schemas.json.",
	);
	expect(run(10_000, "ssr", leaked)).toEqual([]);
	const browser = {
		...bundle,
		"_app/immutable/chunks/queue.js": {
			type: "chunk",
			code: "x",
			moduleIds: ["/repo/src/lib/shared/media-catalog/poyo-queue.json"],
		},
	};
	expect(run(10_000, "client", browser)).toEqual([]);
});
