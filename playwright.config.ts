import { defineConfig } from "@playwright/test";

// Linux runs Chromium and Firefox; macOS CI also runs WebKit (browser key sessions).
export default defineConfig({
	testDir: "./tests/browser",
	use: { trace: "retain-on-failure" },
	projects: [
		{ name: "chromium", use: { browserName: "chromium" } },
		{ name: "firefox", use: { browserName: "firefox" } },
		{ name: "webkit", use: { browserName: "webkit" } },
	],
});
