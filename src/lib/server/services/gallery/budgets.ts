// Gallery's peak-memory budgets (D5): the highest resident set size, in MiB, that each measured
// save scenario may reach in a fresh Bun process (scripts/gallery/measure-save.ts). Only memory
// is gated. These are provisional: each is at least twice its figure on one shared aarch64 host
// (in brackets, from one run of budget.test.ts), rounded up to 32 MiB, until the CI runners'
// figures set the final ceilings at 1.5 × the worst runner.

export const rssCeilingsMiB = {
	/** One 16 MP save at today's bound (173 MiB). */
	current: 448,
	/** One 20 MP save of a stored 8-bit RGBA PNG (279 MiB). */
	png20: 576,
	/** One 20 MP save of a q100 4:4:4 JPEG (236 MiB). */
	jpeg20: 480,
	/** One 20 MP save of a lossless RGBA WebP (436 MiB). */
	webp20: 896,
	/** One 20 MP save of a compressible 16-bit RGB PNG (158 MiB). */
	png16: 384,
	/** One 25 MP classification, held as unsupported (212 MiB). */
	verification25: 448,
	/** Two lossless WebP saves through the worker: two transfers, one verification (517 MiB). */
	saves: 1056,
	/**
	 * Four reads of an 80 MiB file through the route's two permits (502 MiB). The first pair's
	 * buffers are still uncollected when the second pair reads.
	 */
	reads: 1024,
	/**
	 * Two saves, two held 80 MiB reads and one D7 cleanup at once, after two earlier reads left
	 * their buffers uncollected (845 MiB). The read permits bound reads in flight; collection, not
	 * the permits, frees what finished reads leave behind.
	 */
	combined: 1696,
} as const;
