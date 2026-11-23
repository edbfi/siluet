import { expect, test } from "bun:test";
import { parseStageDescriptor } from "./descriptor";

const valid = {
	mime: "image/jpeg" as const,
	transform: "reencoded-rotation" as const,
	draft: crypto.randomUUID(),
	handle: crypto.randomUUID(),
	digest: "a".repeat(64),
	size: 1234,
	deadline: 1_800_000_000_000,
};

test("seven-key descriptors parse and anything else is refused", () => {
	expect(parseStageDescriptor(valid)).toEqual(valid);
	expect(parseStageDescriptor({ ...valid, mime: "image/png", transform: "none" })).toMatchObject({
		mime: "image/png",
	});
	for (const mime of ["image/png", "image/jpeg"])
		expect(parseStageDescriptor({ ...valid, mime, transform: "original" })).toMatchObject({
			mime,
			transform: "original",
		});
	for (const bad of [
		{ ...valid, mime: "image/png" },
		{ ...valid, revision: 1 },
		{ ...valid, transform: "rotated" },
		{ ...valid, extra: 1 },
		{ ...valid, draft: "draft" },
		{ ...valid, size: 0 },
		{ ...valid, deadline: 1.5 },
		Object.fromEntries(Object.entries(valid).filter(([key]) => key !== "transform")),
		null,
		[],
	])
		expect(parseStageDescriptor(bad)).toBeNull();
});
