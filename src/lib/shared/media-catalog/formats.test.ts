import { expect, test } from "bun:test";
import { expectedImageType, offeredFormats, poyoOutputFormats } from "./formats";
import projection from "./poyo-formats.json";
import { seedream55Page } from "./toapis/seedream-5.5";

test("a row offers only its schema's formats that Gallery saves, verbatim and never gif", () => {
	expect(offeredFormats({ values: ["png", "jpeg", "webp", "gif"], default: "png" })).toEqual({
		values: ["png", "jpeg", "webp"],
		preselected: "png",
	});
	// `jpg` stays `jpg`, beside `jpeg` when a schema lists both.
	expect(
		offeredFormats({ values: ["png", "jpg", "jpeg", "webp"], default: "png" })?.values,
	).toEqual(["png", "jpg", "jpeg", "webp"]);
	// Only exact wire values Gallery saves: no case folding, no other types.
	expect(offeredFormats({ values: ["PNG", "gif", "svg", "heic", "jpeg"] })?.values).toEqual([
		"jpeg",
	]);
	expect(offeredFormats({ values: ["gif"], default: "gif" })).toEqual({
		values: [],
		preselected: undefined,
	});
	expect(offeredFormats(undefined)).toBeNull();
});

test("the effective default is preselected only when Gallery saves it; otherwise the first offered format", () => {
	expect(offeredFormats({ values: ["jpeg", "png"], default: "jpeg" })?.preselected).toBe("jpeg");
	expect(offeredFormats({ values: ["jpeg", "png", "webp"], default: "png" })?.preselected).toBe(
		"png",
	);
	// Unresolved: the composer preselects an offered format and sends it.
	expect(offeredFormats({ values: ["png", "jpg"] })?.preselected).toBe("png");
	expect(offeredFormats({ values: ["gif", "webp", "png"], default: "gif" })?.preselected).toBe(
		"webp",
	);
});

test("every derived row that has the option reads its offered formats from the projection", () => {
	const derived = new Map(projection.rows.map((row) => [row.model, row]));
	expect(poyoOutputFormats("seedream-5.5")).toEqual({
		values: ["png", "jpeg"],
		preselected: "png",
	});
	expect(poyoOutputFormats("seedream-5.0-pro")).toEqual({
		values: ["jpeg", "png"],
		preselected: "jpeg",
	});
	expect(poyoOutputFormats("flux-kontext-pro")).toEqual({
		values: ["png", "jpg"],
		preselected: "png",
	});
	expect(poyoOutputFormats("flux-3-klein")).toEqual({
		values: ["jpeg", "png", "webp"],
		preselected: "png",
	});
	// No resolved default: the composer preselects the first offered format and sends it.
	for (const model of [
		"seedream-5.0-flash",
		"seedream-5.0-flash-edit",
		"flux-kontext-max",
		"flux-kontext-max-edit",
		"flux-kontext-pro",
		"flux-kontext-pro-edit",
	])
		expect(
			Object.keys(projection.rows.find((row) => row.model === model)?.output_format ?? {}),
		).toEqual(["values"]);
	expect(poyoOutputFormats("seedream-5.0-flash")?.preselected).toBe("jpeg");
	// The spec's recount: sixteen rows offer WebP.
	expect(
		projection.rows.filter((row) => poyoOutputFormats(row.model)?.values.includes("webp")),
	).toHaveLength(16);
	expect(poyoOutputFormats("nano-banana-2-new")?.values).toEqual(["png", "jpg", "jpeg", "webp"]);
	// The catalog lists gif here and the API schema does not: the shared domain never has it.
	expect(poyoOutputFormats("gpt-image-2.6-flare")?.values).toEqual(["png", "jpeg", "webp"]);
	for (const row of projection.rows) {
		const offered = poyoOutputFormats(row.model);
		if (!("output_format" in row)) expect(offered).toBeNull();
		else expect(offered?.values).not.toContain("gif");
	}
	// Z-Image has no output format option: it may return any type.
	expect(derived.has("z-image")).toBe(true);
	expect(poyoOutputFormats("z-image")).toBeNull();
	expect(() => poyoOutputFormats("not-a-derived-model")).toThrow();
});

test("Review's expected type follows the format the request sends, or is the provider's choice", () => {
	expect(expectedImageType("jpg")).toEqual({ format: "jpg", type: "image/jpeg", name: "JPEG" });
	expect(expectedImageType("jpeg")).toEqual({ format: "jpeg", type: "image/jpeg", name: "JPEG" });
	expect(expectedImageType("png")).toEqual({ format: "png", type: "image/png", name: "PNG" });
	expect(expectedImageType("webp")).toEqual({ format: "webp", type: "image/webp", name: "WebP" });
	expect(expectedImageType(undefined)).toBeNull();
	expect(() => expectedImageType("gif")).toThrow();
});

test("the ToAPIs Seedream 5.5 page records its formats with the quote and page digest", () => {
	expect(seedream55Page.models).toEqual(["doubao-seedream-5-5"]);
	expect(seedream55Page.markdownSha256).toMatch(/^[0-9a-f]{64}$/);
	expect(seedream55Page.outputFormat.quote).toContain(
		"Accepts `png` or `jpeg`, defaulting to `png`",
	);
	expect(offeredFormats(seedream55Page.outputFormat)).toEqual({
		values: ["png", "jpeg"],
		preselected: "png",
	});
});
