import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import ledger from "../../docs/media-catalog.v1.json";
import { canonicalJson } from "../../src/lib/shared/media-catalog/canonical";
import { d4States } from "../../src/lib/shared/media-catalog/filtering";
import { crossCheck, deriveRows, renderRows, rowsPath } from "./derive";
import { verifiedOptions } from "./verified";

const committed = readFileSync(rowsPath, "utf8");
const rows = deriveRows();

test("derivation reproduces the committed rows byte for byte, canonical and under 500 KB", () => {
	expect(renderRows()).toBe(committed);
	expect(`${canonicalJson(JSON.parse(committed))}\n`).toBe(committed);
	expect(Buffer.byteLength(committed)).toBeLessThan(500 * 1024);
});

const documented = ledger.providers.poyo.rows.filter((row) => row.contract === "documented");

test("each documented Poyo.ai ID has one row whose D4 state is the ledger's", () => {
	expect(rows.map(({ model }) => model).sort()).toEqual(
		documented.flatMap((row) => row.ids).sort(),
	);
	for (const row of documented)
		for (const model of row.ids)
			expect(rows.find((derived) => derived.model === model)?.d4.d4 as string).toBe(
				row.d4 as string,
			);
});

test("the migrated ledger matches the inventory query: 39 closed-absent, 31 declared, 89 open-absent", () => {
	// jq '[.providers.poyo.rows[] | select(.contract == "documented") | . as $r | .ids[]
	//   | "\($r.d4 // "-")/\($r.catalogD4 // "-")"] | group_by(.) | map({(.[0]): length}) | add'
	const groups: Record<string, number> = {};
	for (const row of documented)
		for (const _ of row.ids) {
			const key = `${row.d4 ?? "-"}/${("catalogD4" in row && row.catalogD4) || "-"}`;
			groups[key] = (groups[key] ?? 0) + 1;
		}
	expect(groups).toEqual({ "closed-absent/-": 39, "declared/-": 31, "open-absent/-": 89 });
	for (const provider of ["poyo", "toapis"] as const)
		for (const row of ledger.providers[provider].rows) {
			const fields = row as { d4?: string; catalogD4?: string };
			expect([...d4States, undefined]).toContain(fields.d4 as never);
			if (fields.catalogD4 !== undefined) {
				expect(fields.catalogD4).toBe("conflict");
				expect(fields.d4).toBe("contradiction");
			}
		}
});

test("the Gemini Omni Flash rows close in the catalog and stay open in the API schema", () => {
	for (const model of ["gemini-omni-1.1-flash", "gemini-omni-1.2-flash"])
		expect(rows.find((row) => row.model === model)?.d4).toEqual({
			d4: "closed-absent",
			closedBy: "catalog",
		});
	expect(rows.find((row) => row.model === "poyo-ai/image-translator")?.d4).toEqual({
		d4: "closed-absent",
		closedBy: "api",
	});
	expect(rows.find((row) => row.model === "ideogram-v4.6")).toMatchObject({
		d4: { d4: "closed-absent", closedBy: "api" },
		catalog: null,
		pending: ["not in the pinned catalog: G2c re-pins"],
	});
});

test("verified representatives are cross-checked and never rewritten", () => {
	expect(() => crossCheck(rows)).not.toThrow();
	const tampered = verifiedOptions.map((entry) =>
		entry.key.model === "seedream-5.5"
			? { ...entry, offered: { ...entry.offered, resolution: { values: ["1K", "4K"] } } }
			: entry,
	);
	expect(() => crossCheck(rows, tampered)).toThrow('seedream-5.5 resolution offers ["4K"]');
	const undeclared = rows.map((row) =>
		row.model === "h3-max" ? { ...row, d4: { d4: "open-absent" as const } } : row,
	);
	expect(() => crossCheck(undeclared)).toThrow("h3-max disagrees");
});

test("derived rows record constructs, contradictions and unknowns, and nothing queues", () => {
	const option = (model: string, field: string) =>
		rows.find((row) => row.model === model)?.options.find((item) => item.field === field);
	expect(option("gpt-image-2.6-fixed", "resolution")?.gap).toMatchObject({
		state: "unknown",
		question: 7,
	});
	expect(option("gpt-image-2.6-fixed", "resolution")?.default).toEqual({
		state: "unresolved",
		reason: "one source",
	});
	for (const field of ["protect_text", "synthesis_on_image", "translate_on_image"])
		expect(option("poyo-ai/image-translator", field)?.gap?.question).toBe(7);
	expect(option("seedream-4.5", "n")?.disputed).toEqual({
		catalog: { minimum: 1, maximum: 15 },
		api: { minimum: 1, maximum: 6 },
	});
	expect(option("flux-3-klein", "size")?.kind).toBe("rule");
	expect(option("flux-dev", "size")?.gap).toEqual({ state: "pending", reason: "uses oneOf" });
	expect(option("mai-image-2.7", "size")?.gap?.reason).toStartWith("uses pattern");
	expect(option("minimax-h3-image", "size")?.gap?.reason).toBe(
		"domain only in prose: typing rule with G6",
	);
	expect(option("kling-2.5-turbo-pro", "aspect_ratio")?.gap?.question).toBe(11);
	expect(option("seedance-2.5", "prompt")?.gap).toMatchObject({ question: 10 });
	expect(rows.find((row) => row.model === "kling-4.0")?.pending).toEqual([
		"schema uses oneOf in allOf, items in allOf, x-server-validation",
	]);
	expect(rows.find((row) => row.model === "vidu-q4")?.pending).toEqual([]);
	expect(JSON.stringify(rows)).not.toMatch(/"queue"|"eligible"/);
});
