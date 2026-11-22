import { expect, test } from "bun:test";
import { referenceGif, truncatedReferenceGif } from "../../../../tests/fixtures/reference-image";
import { checkReferenceFile, referenceFileError } from "./references";

const pngHeader = [137, 80, 78, 71, 13, 10, 26, 10, 0, 0, 0, 13, 73, 72, 68, 82];

test("checks local reference bytes before staging a supported filename", async () => {
	const text = new File(["text mislabeled as PNG"], "ref.png", { type: "image/png" });
	const png = new File([new Uint8Array(pngHeader)], "ref.png");
	expect(await checkReferenceFile("poyo", text)).toMatch(/valid JPEG, PNG or WebP/);
	expect(await checkReferenceFile("poyo", png)).toBeNull();
});

test("checks the provider format against the file itself", async () => {
	const mislabeled = new File([referenceGif], "ref.png", { type: "image/png" });
	const gif = new File([referenceGif], "ref.gif", { type: "image/gif" });
	expect(await checkReferenceFile("poyo", mislabeled)).toMatch(/valid JPEG, PNG or WebP/);
	expect(await checkReferenceFile("toapis", gif)).toBeNull();
	expect(await checkReferenceFile("toapis", mislabeled)).toMatch(/valid JPEG, PNG, WebP or GIF/);
});

test.each([
	["truncated second frame", truncatedReferenceGif],
	[
		"trailer byte inside an unfinished sub-block",
		Buffer.concat([truncatedReferenceGif, Buffer.from([0x3b])]),
	],
	["missing trailer", referenceGif.subarray(0, -1)],
	["truncated local color table", referenceGif.subarray(0, -8)],
	["trailing data", Buffer.concat([referenceGif, Buffer.from([0x3b])])],
] as const)("rejects a GIF with %s", async (_description, bytes) => {
	// https://www.w3.org/Graphics/GIF/spec-gif89a.txt Appendix B
	const file = new File([bytes], "ref.gif", { type: "image/gif" });
	expect(await checkReferenceFile("toapis", file)).toBe("Choose a complete GIF file.");
});

test("JPEG and PNG source size is checked separately from cleaned upload size", () => {
	const sample = { name: "photo.jpeg", type: "image/jpeg", size: 10_000_001 };
	expect(referenceFileError("poyo", sample)).toBeNull();
	expect(
		referenceFileError("poyo", { ...sample, type: "image/webp", name: "a.webp" }),
	).not.toBeNull();
	expect(
		referenceFileError("toapis", { ...sample, type: "image/png", size: 32_000_001 }),
	).not.toBeNull();
});
