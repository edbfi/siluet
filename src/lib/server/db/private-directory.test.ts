import { expect, test } from "bun:test";
import { chmod, exists, mkdir, realpath, rm, symlink } from "node:fs/promises";
import { tmpdir, userInfo } from "node:os";
import { join } from "node:path";
import { createOwnerDirectory } from "../../../../tests/fixtures/owner-directory";
import { UnsupportedPlatformError } from "../platform";
import { openInstallation } from "./installation";
import {
	preparePrivateDirectory,
	requireStableFolder,
	resolveStablePath,
} from "./private-directory";
import { readLocalAccounts } from "./private-group";

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
		// Group write is covered below, as this host's own groups decide it.
		for (const mode of [0o707, 0o777]) {
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

const uid = process.getuid?.() ?? 0;
const gid = process.getgid?.() ?? 0;
const name = userInfo().username;
const accounts =
	(group: string, passwd = `${name}:x:${uid}:${gid}::/home/${name}:/bin/sh\n`) =>
	async () => ({ group, passwd });
const privateGroup = accounts(`root:x:0:\n${name}:x:${gid}:\n`);

test("a folder only this user's private group can write is stable", async () => {
	const parent = await createOwnerDirectory();
	const shared = join(parent, "shared");
	const directory = join(shared, "siluet");
	try {
		await mkdir(shared, { mode: 0o700 });
		await chmod(shared, 0o775);
		await preparePrivateDirectory(directory, false, privateGroup);
		for (const readAccounts of [
			accounts(`${name}:x:${gid}:${name},guest\n`),
			accounts(`staff:x:${gid}:\n`),
			accounts(
				`${name}:x:${gid}:\n`,
				`${name}:x:${uid}:${gid}::/:/bin/sh\nguest:x:${uid + 1}:${gid}::/:/bin/sh\n`,
			),
			accounts(`${name}:x:${gid + 1}:\n`),
			async () => {
				throw new Error("EACCES");
			},
		])
			await expect(preparePrivateDirectory(directory, true, readAccounts)).rejects.toThrow(
				replaceable,
			);
		await chmod(shared, 0o777);
		await expect(preparePrivateDirectory(directory, true, privateGroup)).rejects.toThrow(
			replaceable,
		);
		await chmod(shared, 0o775);
		const realGid = process.getgid;
		try {
			process.getgid = () => gid + 1;
			await expect(preparePrivateDirectory(directory, true, privateGroup)).rejects.toThrow(
				replaceable,
			);
		} finally {
			process.getgid = realGid;
		}
	} finally {
		await chmod(shared, 0o700).catch(() => {});
		await rm(parent, { recursive: true, force: true });
	}
});

test("a root-owned folder its group can write is stable only when sticky", async () => {
	const folder = (mode: number) => ({ uid: 0, gid, mode, isDirectory: () => true });
	const rootGroup = accounts(`root:x:${gid}:\n`, `root:x:0:${gid}::/root:/bin/sh\n`);
	await expect(requireStableFolder("/srv", folder(0o40775), rootGroup)).rejects.toThrow(
		replaceable,
	);
	await requireStableFolder("/srv", folder(0o41775), rootGroup);
	const realUid = process.getuid;
	try {
		// Root's own group is never treated as private.
		process.getuid = () => 0;
		await expect(requireStableFolder("/srv", folder(0o40775), rootGroup)).rejects.toThrow(
			replaceable,
		);
	} finally {
		process.getuid = realUid;
	}
});

test("a link in the configured path is checked where it sits, then the canonical path is used", async () => {
	const parent = await createOwnerDirectory();
	const open = join(parent, "open");
	const target = join(parent, "private");
	try {
		await mkdir(open, { mode: 0o700 });
		await mkdir(target, { mode: 0o700 });
		await symlink(target, join(open, "link"));
		const canonical = join(await realpath(target), "siluet");
		expect(await preparePrivateDirectory(join(open, "link", "siluet"))).toBe(canonical);
		expect(await preparePrivateDirectory(join(open, "link", "siluet"), true)).toBe(canonical);
		// Another user could repoint the link, whatever its target.
		await chmod(open, 0o777);
		for (const existing of [false, true])
			await expect(preparePrivateDirectory(join(open, "link", "siluet"), existing)).rejects.toThrow(
				replaceable,
			);
	} finally {
		await chmod(open, 0o700).catch(() => {});
		await rm(parent, { recursive: true, force: true });
	}
});

test("every link on the way is checked, including a link a link leads to", async () => {
	const parent = await createOwnerDirectory();
	const home = join(parent, "home");
	const open = join(parent, "open");
	const target = join(parent, "private");
	const directory = join(home, "link", "siluet");
	try {
		for (const folder of [home, open, target]) await mkdir(folder, { mode: 0o700 });
		await symlink(join(open, "link2"), join(home, "link"));
		await symlink(target, join(open, "link2"));
		expect(await preparePrivateDirectory(directory)).toBe(join(await realpath(target), "siluet"));
		// Another user could repoint link2, which the configured path never names.
		await chmod(open, 0o777);
		for (const existing of [false, true])
			await expect(preparePrivateDirectory(directory, existing)).rejects.toThrow(replaceable);
	} finally {
		await chmod(open, 0o700).catch(() => {});
		await rm(parent, { recursive: true, force: true });
	}
});

test("a configured link with a trailing slash is checked as a link", async () => {
	const parent = await createOwnerDirectory();
	const open = join(parent, "open");
	const target = join(parent, "private", "siluet");
	try {
		await mkdir(open, { mode: 0o700 });
		await mkdir(target, { recursive: true, mode: 0o700 });
		await symlink(target, join(open, "link"));
		expect(await preparePrivateDirectory(`${join(open, "link")}//`, true)).toBe(
			await realpath(target),
		);
		await chmod(open, 0o777);
		await expect(preparePrivateDirectory(`${join(open, "link")}/`, true)).rejects.toThrow(
			replaceable,
		);
	} finally {
		await chmod(open, 0o700).catch(() => {});
		await rm(parent, { recursive: true, force: true });
	}
});

test("relative and system links resolve to the path the kernel opens", async () => {
	const parent = await createOwnerDirectory();
	try {
		// Like macOS /var -> private/var, resolved against the link's own folder.
		await mkdir(join(parent, "private", "var"), { recursive: true, mode: 0o700 });
		await symlink("private/var", join(parent, "var"));
		await symlink("../var/.", join(parent, "private", "up"));
		const real = await realpath(join(parent, "private", "var"));
		expect(await preparePrivateDirectory(join(parent, "var", "siluet"))).toBe(join(real, "siluet"));
		expect(await preparePrivateDirectory(join(parent, "private", "up", "siluet"), true)).toBe(
			join(real, "siluet"),
		);
		// Root's own links, such as /tmp on macOS or /bin/sh on Debian, are trusted.
		for (const path of ["/", "/tmp", "/bin/sh", tmpdir()])
			expect(await resolveStablePath(path, readLocalAccounts)).toBe(await realpath(path));
	} finally {
		await rm(parent, { recursive: true, force: true });
	}
});

test("a link loop is refused", async () => {
	const parent = await createOwnerDirectory();
	try {
		await symlink(join(parent, "b"), join(parent, "a"));
		await symlink("a", join(parent, "b"));
		await symlink("self", join(parent, "self"));
		for (const directory of [join(parent, "a", "siluet"), join(parent, "self")])
			for (const existing of [false, true])
				await expect(preparePrivateDirectory(directory, existing)).rejects.toThrow(
					"too many links",
				);
	} finally {
		await rm(parent, { recursive: true, force: true });
	}
});

test("the refusal names the folder and how to close it", async () => {
	const parent = await createOwnerDirectory();
	const shared = join(parent, "it's shared");
	try {
		await mkdir(shared, { mode: 0o700 });
		await chmod(shared, 0o777);
		const error = await preparePrivateDirectory(join(shared, "siluet")).catch((e: unknown) => e);
		expect(error).toBeInstanceOf(Error);
		const message = (error as Error).message;
		expect(message).toContain(shared);
		expect(message).toContain(`chmod g-w,o-w '${shared.replaceAll("'", "'\\''")}'`);
		// A folder another user owns cannot be fixed with chmod.
		await chmod(shared, 0o700);
		await preparePrivateDirectory(join(shared, "siluet"));
		const realUid = process.getuid;
		try {
			process.getuid = () => (realUid?.() ?? 0) + 1;
			const foreign = await preparePrivateDirectory(join(shared, "siluet"), true).catch(
				(e: unknown) => e,
			);
			expect((foreign as Error).message).toContain("belongs to another user");
			expect((foreign as Error).message).not.toContain("chmod");
		} finally {
			process.getuid = realUid;
		}
	} finally {
		await chmod(shared, 0o700).catch(() => {});
		await rm(parent, { recursive: true, force: true });
	}
});
