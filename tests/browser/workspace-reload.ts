import { realpathSync } from "node:fs";
import { realpath, stat } from "node:fs/promises";
import { dirname, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "./studio-test";

// Under load, Chromium sometimes starts a reloaded file:// document with empty
// localStorage. Reload tests therefore read the same files from this routed
// secure-context origin, which needs no network and keeps its storage. Reload
// persistence is checked over this origin only; other workspace tests still
// open and reload file:// entries directly.
export const reloadOrigin = "http://workspace.localhost";

// Only the directories of entries passed to reloadUrl during the current test
// are served. Each is resolved once, so a spec's deleted temp folder cannot
// affect a later spec in the same worker.
const roots = new Set<string>();

export const reloadUrl = (file: URL) => {
	roots.add(`${realpathSync(dirname(fileURLToPath(file)))}${sep}`);
	return `${reloadOrigin}${file.pathname}`;
};

async function servedPath(url: string) {
	try {
		const path = await realpath(fileURLToPath(`file://${new URL(url).pathname}`));
		if ([...roots].some((root) => path.startsWith(root)))
			return (await stat(path)).isFile() ? path : undefined;
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
			roots.clear();
			await context.close();
		}
	},
});
