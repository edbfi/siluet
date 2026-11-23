import { exists, rm } from "node:fs/promises";
import { join } from "node:path";
import { expect, test } from "@playwright/test";
import { unsupportedPlatformMessage } from "../../src/lib/server/platform";
import { createOwnerDirectory } from "../fixtures/owner-directory";

test("the built server refuses a foreign platform", async () => {
	const parent = await createOwnerDirectory();
	try {
		const directory = join(parent, "siluet");
		const server = Bun.spawn(
			[
				process.execPath,
				"--preload",
				join(process.cwd(), "tests/fixtures/foreign-platform.ts"),
				"build/index.js",
			],
			{
				env: {
					...process.env,
					SILUET_DATA_DIR: directory,
					SILUET_SERVER_PORT: "0",
					SILUET_TEST_PLATFORM: "freebsd",
				},
				stdout: "pipe",
				stderr: "pipe",
			},
		);
		const timer = setTimeout(() => server.kill(), 10000);
		try {
			expect(await server.exited).not.toBe(0);
		} finally {
			clearTimeout(timer);
		}
		expect(await new Response(server.stderr).text()).toContain(unsupportedPlatformMessage);
		expect(await exists(directory)).toBe(false);
	} finally {
		await rm(parent, { recursive: true, force: true });
	}
});
