import { expect, test } from "bun:test";
import { checkReferenceFile } from "./references";

const pngHeader = [137, 80, 78, 71, 13, 10, 26, 10, 0, 0, 0, 13, 73, 72, 68, 82];
const gifHeader = ["GIF89a", new Uint8Array(7)];

test("checks local reference bytes before staging a supported filename", async () => {
	const text = new File(["text mislabeled as PNG"], "ref.png", { type: "image/png" });
	const png = new File([new Uint8Array(pngHeader)], "ref.png");
	expect(await checkReferenceFile("poyo", text)).toMatch(/valid JPEG, PNG or WebP/);
	expect(await checkReferenceFile("poyo", png)).toBeNull();
});

test("checks the provider format against the file itself", async () => {
	const mislabeled = new File(gifHeader, "ref.png", { type: "image/png" });
	const gif = new File(gifHeader, "ref.gif", { type: "image/gif" });
	expect(await checkReferenceFile("poyo", mislabeled)).toMatch(/valid JPEG, PNG or WebP/);
	expect(await checkReferenceFile("toapis", gif)).toBeNull();
	expect(await checkReferenceFile("toapis", mislabeled)).toMatch(/valid JPEG, PNG, WebP or GIF/);
});
