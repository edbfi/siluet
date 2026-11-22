import { realpath, stat } from "node:fs/promises";
import { dirname, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "@playwright/test";

// Under load, Chromium sometimes starts a reloaded file:// document with empty
// localStorage. Reload tests therefore read the same files from this routed
// secure-context origin, which needs no network and keeps its storage. Reload
// persistence is checked over this origin only; other workspace tests still
// open and reload file:// entries directly.
export const reloadOrigin = "http://workspace.localhost";

// Only the directories of entries passed to reloadUrl are served.
const roots = new Set<string>();

export const reloadUrl = (file: URL) => {
	roots.add(dirname(fileURLToPath(file)));
	return `${reloadOrigin}${file.pathname}`;
};

async function servedPath(url: string) {
	try {
		const path = await realpath(fileURLToPath(`file://${new URL(url).pathname}`));
		for (const root of roots) {
			if (!path.startsWith(`${await realpath(root)}${sep}`)) continue;
			return (await stat(path)).isFile() ? path : undefined;
		}
	} catch {
		// Missing files and malformed paths are answered with 404.
	}
	return undefined;
}

export const reloadTest = test.extend({
	context: async ({ browserName, headless, locale, offline, playwright, timezoneId }, use) => {
		// Exercise reloads with a fresh, disk-backed profile.
		const context = await playwright[browserName].launchPersistentContext("", {
			headless,
			locale,
			offline,
			timezoneId,
		});
		try {
			await context.route(`${reloadOrigin}/**`, async (route) => {
				const path = await servedPath(route.request().url());
				await route.fulfill(path ? { path } : { status: 404 });
			});
			await use(context);
		} finally {
			await context.close();
		}
	},
});
