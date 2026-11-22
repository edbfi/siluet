import { stat } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { test } from "@playwright/test";

// Under load, Chromium sometimes starts a reloaded file:// document with empty
// localStorage. Reload tests therefore read the same files from this routed
// secure-context origin, which needs no network and keeps its storage.
export const reloadOrigin = "http://workspace.localhost";

export const reloadUrl = (file: URL) => `${reloadOrigin}${file.pathname}`;

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
				const path = fileURLToPath(`file://${new URL(route.request().url()).pathname}`);
				const found = await stat(path).then(
					(entry) => entry.isFile(),
					() => false,
				);
				await route.fulfill(found ? { path } : { status: 404 });
			});
			await use(context);
		} finally {
			await context.close();
		}
	},
});
