import { test } from "@playwright/test";

export const reloadTest = test.extend({
	context: async ({ browserName, headless, locale, offline, playwright, timezoneId }, use) => {
		// Exercise direct-file reloads with a fresh, disk-backed profile.
		const context = await playwright[browserName].launchPersistentContext("", {
			headless,
			locale,
			offline,
			timezoneId,
		});
		try {
			await use(context);
		} finally {
			await context.close();
		}
	},
});
