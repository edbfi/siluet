import { expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { providerKeyFilename } from "../src/lib/server/db/provider-key";
import { checkPublicAssets, guardPublicAssets } from "./public-assets";

test("public assets admit regular media and exclude linked directories and owner state", async () => {
	const temp = await mkdtemp(join(tmpdir(), "siluet-assets-"));
	try {
		const assets = join(temp, "static");
		expect(() => checkPublicAssets(assets)).not.toThrow();
		await mkdir(assets);
		await writeFile(join(assets, "cover.png"), "fixture");
		expect(() => checkPublicAssets(assets)).not.toThrow();
		await symlink(temp, join(assets, "linked"));
		expect(() => checkPublicAssets(assets)).toThrow("Public assets");
		await rm(join(assets, "linked"));
		for (const name of [
			"studio.db-wal",
			"owner-recovery.sqlite",
			"owner-recovery.sqlite-journal",
			providerKeyFilename,
			"factor-1.key",
		]) {
			await writeFile(join(assets, name), "fixture");
			expect(() => checkPublicAssets(assets), name).toThrow("Public assets");
			await rm(join(assets, name));
		}
		expect(() => checkPublicAssets(assets)).not.toThrow();
	} finally {
		await rm(temp, { recursive: true, force: true });
	}
});

test("the dev server rechecks public files added after startup", async () => {
	const { createServer } = await import("vite");
	const root = await mkdtemp(join(tmpdir(), "siluet-dev-assets-"));
	const assets = join(root, "static");
	await mkdir(assets);
	await writeFile(join(assets, "cover.txt"), "fixture");
	const server = await createServer({
		root,
		configFile: false,
		appType: "custom",
		optimizeDeps: { noDiscovery: true },
		publicDir: assets,
		plugins: [guardPublicAssets(assets)],
		server: { host: "127.0.0.1", port: 0, watch: null, hmr: false },
	});
	try {
		await server.listen();
		const origin = server.resolvedUrls?.local[0];
		if (!origin) throw new Error("Missing dev server address.");
		expect(await (await fetch(new URL("cover.txt", origin))).text()).toBe("fixture");
		await writeFile(join(assets, "installation.id"), "fixture");
		expect((await fetch(new URL("installation.id", origin))).status).toBe(403);
		await rm(join(assets, "installation.id"));
		expect(await (await fetch(new URL("cover.txt", origin))).text()).toBe("fixture");
	} finally {
		await server.close();
		await rm(root, { recursive: true, force: true });
	}
});
