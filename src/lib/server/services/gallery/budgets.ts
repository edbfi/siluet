// Gallery's peak-memory budgets (D5): the highest resident set size, in MiB, that each measured
// save scenario may reach in a fresh Bun process (scripts/gallery/measure-save.ts). Only memory
// is gated. These are provisional: each is twice a measurement on one shared aarch64 host, rounded
// up to 32 MiB, until the CI runners' figures set the final ceilings at 1.5 × the worst runner.

export const rssCeilingsMiB = {
	/** One 16 MP save at today's bound, measured through the harness. */
	current: 448,
	/** One 20 MP save of a stored 8-bit RGBA PNG, from the 5000×4000 probe. */
	png20: 480,
	/** One 20 MP save of a q100 4:4:4 JPEG, from the probe. */
	jpeg20: 384,
	/** One 20 MP save of a lossless RGBA WebP, from the probe. */
	webp20: 800,
	/** One 20 MP save of a compressible 16-bit RGB PNG, from the probe. */
	png16: 384,
	/** One 25 MP classification, held as unsupported (217 MiB locally). */
	verification25: 448,
	/** Two lossless WebP saves through the worker: two transfers, one verification (520 MiB). */
	saves: 1056,
	/**
	 * Four reads of an 80 MiB file through the route's two permits (506 MiB). The first pair's
	 * buffers are still uncollected when the second pair reads.
	 */
	reads: 1024,
	/** Two saves, two held 80 MiB reads and one D7 cleanup at once (820 MiB). */
	combined: 1664,
} as const;
