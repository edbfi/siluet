import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import poyoV1 from "../../pricing/v1/feed.json";
import poyoV2 from "../../pricing/v2/poyo.json";
import { loadBundledPricing, loadLocalPricing, pricingBundledPath } from "./local-feed";

test("the CLI reads the bundled v2 feed and falls back to v1 without it", async () => {
	expect(pricingBundledPath("poyo-v2")).toEndWith(join("pricing", "v2", "poyo.json"));
	expect(pricingBundledPath("poyo")).toEndWith(join("pricing", "v1", "feed.json"));
	expect<unknown>(await loadBundledPricing("poyo")).toEqual(poyoV2);
	const directory = await mkdtemp(join(tmpdir(), "siluet-cli-bundle-"));
	try {
		const paths = {
			cachePath: join(directory, "v1.json"),
			v2CachePath: join(directory, "v2.json"),
		};
		const now = Date.parse(poyoV2.sourceDate);
		expect<unknown>(await loadLocalPricing(now, paths)).toEqual(poyoV2);
		expect<unknown>(
			await loadLocalPricing(now, { ...paths, v2BundledPath: join(directory, "missing.json") }),
		).toEqual(poyoV1);
	} finally {
		await rm(directory, { recursive: true, force: true });
	}
});
