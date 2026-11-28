// Gallery's image limits (catalog engine spec, "Gallery size limits"; D5). The verifier, the
// download, the browser's per-image read limit and Review's statement all read them here, so
// the stated "N megapixels" cannot drift from what Save accepts.

const MiB = 1024 * 1024;

export const galleryImageLimits = {
	/** The most pixels a saved image may have, inclusive. */
	pixels: 16_000_000,
	/** The longest edge a saved image may have, inclusive. */
	edge: 16_384,
	/** The largest encoded image Gallery downloads, saves and reads back. */
	bytes: 32 * MiB,
} as const;

/** Gallery's pixel limit in megapixels, as Review states it. */
export const galleryMegapixels = galleryImageLimits.pixels / 1_000_000;
