import { afterEach, beforeEach, expect, test } from "bun:test";
import { chmod, lstat, mkdtemp, readFile, rm, symlink, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { sql } from "drizzle-orm";
import { openInstallation } from "./installation";

let directory: string;
beforeEach(async () => {
	directory = await mkdtemp(join(tmpdir(), "siluet-storage-"));
});
afterEach(async () => {
	await rm(directory, { recursive: true, force: true });
});

test("an empty directory initializes once and reopens the same installation", async () => {
	const initial = await openInstallation(directory);
	expect(await initial.hasOwner()).toBe(false);
	const id = initial.id;
	await initial.close();
	const reopened = await openInstallation(directory);
	expect(reopened.id).toBe(id);
	expect(await reopened.hasOwner()).toBe(false);
	await reopened.close();
});

test.each(["studio.db", "installation.id"])(
	"an installation missing %s stays closed",
	async (file) => {
		const initial = await openInstallation(directory);
		await initial.close();
		await unlink(join(directory, file));
		await expect(openInstallation(directory)).rejects.toThrow("storage");
		await expect(readFile(join(directory, file))).rejects.toThrow();
	},
);

test("a database and marker from different installations are rejected", async () => {
	const initial = await openInstallation(directory);
	await initial.close();
	await writeFile(join(directory, "installation.id"), crypto.randomUUID());
	await expect(openInstallation(directory)).rejects.toThrow("storage");
});

test("a missing session table keeps setup closed", async () => {
	const initial = await openInstallation(directory);
	await initial.use((db) => db.run(sql`DROP TABLE session`));
	await initial.close();
	await expect(openInstallation(directory)).rejects.toThrow("storage");
});
test("a migration from a different build prevents startup", async () => {
	const initial = await openInstallation(directory);
	await initial.use((db) => db.run(sql`UPDATE __drizzle_migrations SET name='unknown'`));
	await initial.close();
	await expect(openInstallation(directory)).rejects.toThrow("storage");
});

test("a private directory inside the studio checkout is rejected before credentials are written", async () => {
	const served = await mkdtemp(join(process.cwd(), "owner-directory-test-"));
	try {
		const alias = join(directory, "alias");
		await symlink(served, alias, "junction");
		const outward = join(served, "external");
		await symlink(directory, outward, "junction");
		for (const root of [served, alias, outward]) {
			const data = join(root, "settings");
			await expect(openInstallation(data)).rejects.toThrow("outside the studio files");
			await expect(lstat(data)).rejects.toMatchObject({ code: "ENOENT" });
			expect(await Bun.file(join(data, "installation.id")).exists()).toBe(false);
		}
	} finally {
		await rm(served, { recursive: true, force: true });
	}
});

test.skipIf(process.platform !== "win32")(
	"an NTFS grant to other local users prevents initialization",
	async () => {
		// Give the well-known Users group read access on this empty fixture only.
		const grant = Bun.spawn(["icacls.exe", directory, "/grant", "*S-1-5-32-545:(OI)(CI)R"], {
			stdout: "ignore",
			stderr: "ignore",
		});
		expect(await grant.exited).toBe(0);
		await expect(openInstallation(directory)).rejects.toThrow("must be private");
		expect(await Bun.file(join(directory, "installation.id")).exists()).toBe(false);
	},
);

test("a claimed marker in the database requires its owner row", async () => {
	const initial = await openInstallation(directory);
	await initial.use((db) => db.run(sql`UPDATE installation SET claimed=1`));
	await initial.close();
	await expect(openInstallation(directory)).rejects.toThrow("storage");
});
test("an interrupted first initialization gives recovery guidance and stays closed", async () => {
	const id = crypto.randomUUID();
	await writeFile(join(directory, "installation.id"), id);
	await writeFile(join(directory, "studio.db"), "");
	await expect(openInstallation(directory)).rejects.toThrow("restore the installation backup");
	expect(await readFile(join(directory, "installation.id"), "utf8")).toBe(id);
	await expect(openInstallation(directory)).rejects.toThrow("restore the installation backup");
});

test("a damaged database stops startup with a redacted error", async () => {
	const initial = await openInstallation(directory);
	await initial.close();
	await writeFile(join(directory, "studio.db"), "unreadable database fixture");
	await expect(openInstallation(directory)).rejects.toThrow(
		"Studio storage could not be verified. Check the installation directory.",
	);
});
test("an unrelated file prevents first initialization", async () => {
	await writeFile(join(directory, "existing"), "preserve");
	await expect(openInstallation(directory)).rejects.toThrow("storage");
	expect(await Bun.file(join(directory, "installation.id")).exists()).toBe(false);
});
test.skipIf(process.platform === "win32")(
	"group readable storage is rejected before initialization",
	async () => {
		await chmod(directory, 0o750);
		await expect(openInstallation(directory)).rejects.toThrow("must be private");
		expect(await Bun.file(join(directory, "installation.id")).exists()).toBe(false);
	},
);

test("an unrelated working directory does not become the installation's checkout", async () => {
	const entry = new URL("./installation.ts", import.meta.url).href;
	const child = Bun.spawn(
		[
			process.execPath,
			"-e",
			`const {openInstallation} = await import(${JSON.stringify(entry)}); const install = await openInstallation(process.cwd()); await install.close();`,
		],
		{ cwd: directory, stdout: "ignore", stderr: "ignore" },
	);
	expect(await child.exited).toBe(0);
});

test("directory policy errors identify a relative path without echoing it", async () => {
	await expect(openInstallation("relative/private")).rejects.toThrow(
		"An absolute data directory is required.",
	);
});
