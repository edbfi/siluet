import { defineConfig } from "@playwright/test";

export default defineConfig({
	testDir: "./tests/browser",
	use: { browserName: "chromium" },
	webServer: {
		command: "bun design/workspace/export.js && bun run start",
		env: { SILUET_SERVER_PORT: "0" },
		wait: { stdout: /Listening on (?<siluet_test_url>http:\/\/127\.0\.0\.1:\d+)/ },
	},
});
