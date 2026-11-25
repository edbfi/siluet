import { defineConfig } from "@playwright/test";

// Built-app journeys run in Chromium and Firefox on Linux and also in WebKit on macOS
// (browser key sessions, D8). The design mockups under design/workspace stay Chromium-only.
const mockups = [
	"**/workspace-*.spec.ts",
	"**/composer-inputs.spec.ts",
	"**/gallery-viewer.spec.ts",
	"**/setup-replay.spec.ts",
];
export default defineConfig({
	testDir: "./tests/browser",
	use: { trace: "retain-on-failure" },
	projects: [
		{ name: "chromium", use: { browserName: "chromium" } },
		{ name: "firefox", use: { browserName: "firefox" }, testIgnore: mockups },
		...(process.platform === "darwin"
			? [{ name: "webkit", use: { browserName: "webkit" as const }, testIgnore: mockups }]
			: []),
	],
});
