import { expect, test } from "bun:test";
import { cp, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import poyoV1 from "../../pricing/v1/feed.json";
import poyoV2 from "../../pricing/v2/poyo.json";
import { loadBundledPricing, loadLocalPricing, pricingBundledPath } from "./local-feed";

const checkout = join(import.meta.dir, "..", "..");

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

test("the CLI starts from a checkout without the bundled v2 feed", async () => {
	const directory = await mkdtemp(join(tmpdir(), "siluet-cli-v1-only-"));
	try {
		for (const path of [
			"scripts/pricing",
			"src/lib/shared/pricing",
			"src/lib/shared/video-studio",
			"src/lib/server/services/pricing",
			"pricing/v1",
		]) {
			await cp(join(checkout, path), join(directory, path), { recursive: true });
		}
		const estimate = Bun.spawnSync(
			[process.execPath, "scripts/pricing/estimate.ts", "--model", "z-image"],
			{
				cwd: directory,
				env: { ...process.env, XDG_CACHE_HOME: join(directory, "cache") },
				stderr: "pipe",
			},
		);
		expect(estimate.stderr.toString()).toBe("");
		expect(estimate.exitCode).toBe(0);
		const result: unknown = JSON.parse(estimate.stdout.toString());
		expect(result).not.toMatchObject({ reason: "missing-feed" });
	} finally {
		await rm(directory, { recursive: true, force: true });
	}
});
