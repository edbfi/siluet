import { expect, test } from "bun:test";
import { galleryStatement } from "../image-studio/derived-review";
import { galleryImageLimits, galleryMegapixels } from "./limits";

test("Review states Gallery's pixel limit in whole megapixels, read from the shared limit", () => {
	expect(galleryMegapixels).toBe(galleryImageLimits.pixels / 1_000_000);
	expect(galleryStatement).toBe(
		"Gallery saves images up to 20 megapixels. A completed billable image over that stays with the provider.",
	);
});

test("Gallery's image limits are one pixel count, one edge and one encoded size", () => {
	expect(galleryImageLimits).toEqual({ pixels: 20_000_000, edge: 16_384, bytes: 80 * 1024 * 1024 });
	expect(Number.isInteger(galleryMegapixels)).toBe(true);
});
