import { expect, test } from "bun:test";
import { exists, rm } from "node:fs/promises";
import { join } from "node:path";
import { createOwnerDirectory } from "../../../../tests/fixtures/owner-directory";
import { UnsupportedPlatformError } from "../platform";
import { preparePrivateDirectory } from "./private-directory";

test("preparation refuses a foreign platform without mkdir", async () => {
	const parent = await createOwnerDirectory();
	const directory = join(parent, "siluet");
	const platform = Object.getOwnPropertyDescriptor(process, "platform");
	try {
		if (!platform) throw new Error("Expected process.platform.");
		Object.defineProperty(process, "platform", { ...platform, value: "freebsd" });
		await expect(preparePrivateDirectory(directory)).rejects.toThrow(UnsupportedPlatformError);
		expect(await exists(directory)).toBe(false);
	} finally {
		if (platform) Object.defineProperty(process, "platform", platform);
		await rm(parent, { recursive: true, force: true });
	}
});
