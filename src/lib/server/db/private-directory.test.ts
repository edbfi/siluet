import { expect, test } from "bun:test";
import { chmod, exists, mkdir, rm } from "node:fs/promises";
import { join } from "node:path";
import { createOwnerDirectory } from "../../../../tests/fixtures/owner-directory";
import { UnsupportedPlatformError } from "../platform";
import { openInstallation } from "./installation";
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

const replaceable = "Another user could replace the data directory";

test("startup and recovery refuse a data directory below a folder others can write", async () => {
	const parent = await createOwnerDirectory();
	const shared = join(parent, "shared");
	const directory = join(shared, "nested", "siluet");
	try {
		await mkdir(shared, { mode: 0o700 });
		await preparePrivateDirectory(directory);
		for (const mode of [0o770, 0o707, 0o775]) {
			await chmod(shared, mode);
			await expect(preparePrivateDirectory(directory)).rejects.toThrow(replaceable);
			await expect(preparePrivateDirectory(directory, true)).rejects.toThrow(replaceable);
			await expect(openInstallation(directory, "recovery")).rejects.toThrow(replaceable);
		}
		// A sticky folder, like /tmp, keeps each entry its creator's.
		await chmod(shared, 0o1777);
		await preparePrivateDirectory(directory);
		await chmod(shared, 0o755);
		await preparePrivateDirectory(directory, true);
	} finally {
		await chmod(shared, 0o700).catch(() => {});
		await rm(parent, { recursive: true, force: true });
	}
});

test("a data directory below a folder another user owns is refused", async () => {
	const parent = await createOwnerDirectory();
	const directory = join(parent, "siluet");
	const real = process.getuid;
	try {
		await preparePrivateDirectory(directory);
		// Seen as another user, the temporary folders belong to someone else; / and /tmp to root.
		process.getuid = () => (real?.() ?? 0) + 1;
		await expect(preparePrivateDirectory(directory, true)).rejects.toThrow(replaceable);
	} finally {
		process.getuid = real;
		await rm(parent, { recursive: true, force: true });
	}
});

test("a new data directory below a folder others can write is refused before mkdir", async () => {
	const parent = await createOwnerDirectory();
	const directory = join(parent, "new", "siluet");
	try {
		await chmod(parent, 0o777);
		await expect(preparePrivateDirectory(directory)).rejects.toThrow(replaceable);
		expect(await exists(join(parent, "new"))).toBe(false);
	} finally {
		await chmod(parent, 0o700);
		await rm(parent, { recursive: true, force: true });
	}
});
