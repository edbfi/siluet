import { expect, test } from "bun:test";
import { expectedImageType, offeredFormats } from "./formats";
import { poyoOutputFormats } from "./poyo-formats";
import projection from "./poyo-formats.json";
import { seedream55Page } from "./toapis/seedream-5.5";

test("a row offers only its schema's formats that Gallery saves, verbatim and never gif", () => {
	expect(offeredFormats({ values: ["png", "jpeg", "webp", "gif"], default: "png" })).toEqual({
		state: "offered",
		values: ["png", "jpeg", "webp"],
		preselected: "png",
	});
	// `jpg` stays `jpg`, beside `jpeg` when a schema lists both.
	expect(offeredFormats({ values: ["png", "jpg", "jpeg", "webp"], default: "png" })).toMatchObject({
		values: ["png", "jpg", "jpeg", "webp"],
	});
	// Only exact wire values Gallery saves: no case folding, no other types.
	expect(offeredFormats({ values: ["PNG", "gif", "svg", "heic", "jpeg"] })).toMatchObject({
		values: ["jpeg"],
	});
});

test("a format option offers something, is unsavable, or is absent; it never offers nothing", () => {
	expect(offeredFormats({ values: ["gif"], default: "gif" })).toEqual({
		state: "unsavable",
		reason: "Gallery saves none of its output formats",
	});
	expect(offeredFormats({ values: [] })).toEqual({
		state: "unsavable",
		reason: "Gallery saves none of its output formats",
	});
	expect(offeredFormats({ pending: "uses oneOf" })).toEqual({
		state: "unsavable",
		reason: "uses oneOf",
	});
	expect(offeredFormats(undefined)).toEqual({ state: "none" });
	for (const evidence of [{ values: ["gif"] }, { values: [] }, { pending: "x" }, undefined])
		expect(() => offeredFormats(evidence)).not.toThrow();
});

test("the effective default is preselected only when Gallery saves it; otherwise the first offered format", () => {
	const preselected = (evidence: Parameters<typeof offeredFormats>[0]) => {
		const formats = offeredFormats(evidence);
		return formats.state === "offered" ? formats.preselected : null;
	};
	expect(preselected({ values: ["jpeg", "png"], default: "jpeg" })).toBe("jpeg");
	expect(preselected({ values: ["jpeg", "png", "webp"], default: "png" })).toBe("png");
	// Unresolved: the composer preselects an offered format and sends it.
	expect(preselected({ values: ["png", "jpg"] })).toBe("png");
	expect(preselected({ values: ["gif", "webp", "png"], default: "gif" })).toBe("webp");
});

test("every derived row that has the option reads its offered formats from the projection", () => {
	const derived = new Map(projection.rows.map((row) => [row.model, row]));
	const offered = (values: string[], preselected: string) => ({
		state: "offered" as const,
		values,
		preselected,
	});
	expect(poyoOutputFormats("seedream-5.5")).toEqual(offered(["png", "jpeg"], "png"));
	expect(poyoOutputFormats("seedream-5.0-pro")).toEqual(offered(["jpeg", "png"], "jpeg"));
	expect(poyoOutputFormats("flux-kontext-pro")).toEqual(offered(["png", "jpg"], "png"));
	expect(poyoOutputFormats("flux-3-klein")).toEqual(offered(["jpeg", "png", "webp"], "png"));
	const values = (model: string) => {
		const formats = poyoOutputFormats(model);
		return formats.state === "offered" ? formats.values : [];
	};
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
	expect(poyoOutputFormats("seedream-5.0-flash")).toMatchObject({ preselected: "jpeg" });
	// The spec's recount: sixteen rows offer WebP.
	expect(projection.rows.filter((row) => values(row.model).includes("webp"))).toHaveLength(16);
	expect(values("nano-banana-2-new")).toEqual(["png", "jpg", "jpeg", "webp"]);
	// The catalog lists gif here and the API schema does not: the shared domain never has it.
	expect(values("gpt-image-2.6-flare")).toEqual(["png", "jpeg", "webp"]);
	for (const row of projection.rows) {
		const formats = poyoOutputFormats(row.model);
		if (!("output_format" in row)) expect(formats).toEqual({ state: "none" });
		else expect(formats).toMatchObject({ state: "offered" });
		expect(values(row.model)).not.toContain("gif");
	}
	// Z-Image has no output format option: it may return any type.
	expect(derived.has("z-image")).toBe(true);
	expect(poyoOutputFormats("z-image")).toEqual({ state: "none" });
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
		state: "offered",
		values: ["png", "jpeg"],
		preselected: "png",
	});
});
