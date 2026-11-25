import { defineConfig } from "@playwright/test";

// Linux runs Chromium and Firefox; macOS also runs WebKit (browser key sessions, D8).
export default defineConfig({
	testDir: "./tests/browser",
	use: { trace: "retain-on-failure" },
	projects: [
		{ name: "chromium", use: { browserName: "chromium" } },
		{ name: "firefox", use: { browserName: "firefox" } },
		...(process.platform === "darwin"
			? [{ name: "webkit", use: { browserName: "webkit" as const } }]
			: []),
	],
});
