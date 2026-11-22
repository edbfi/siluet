import { expect, test } from "bun:test";
import { chmod, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { createOwnerDirectory } from "../../../../tests/fixtures/owner-directory";
import { openInstallation } from "./installation";
import { lockFilename } from "./recovery-lock";

test("only startup initializes the sidecar and recovery excludes an open installation", async () => {
	const directory = await createOwnerDirectory();
	try {
		await expect(openInstallation(directory, "recovery")).rejects.toThrow();
		const install = await openInstallation(directory);
		const stable = join(directory, lockFilename);
		try {
			await expect(openInstallation(directory, "recovery")).rejects.toThrow();
		} finally {
			await install.close();
		}
		const original = await readFile(stable);
		await expect(openInstallation(directory, "recovery")).rejects.toThrow();
		expect(await readFile(stable)).toEqual(original);
		if (process.platform !== "win32") {
			await chmod(stable, 0o644);
			await expect(openInstallation(directory)).rejects.toThrow();
		}
	} finally {
		await rm(directory, { recursive: true, force: true });
	}
});

test("separate processes exclude two servers and exclusive recovery until forced exit", async () => {
	const dir = await createOwnerDirectory();
	const launch = (mode: string) => {
		const started = Promise.withResolvers<boolean>();
		const child = Bun.spawn([process.execPath, "tests/fixtures/hold-owner-storage.ts", dir, mode], {
			ipc: () => started.resolve(true),
			stdout: "ignore",
			stderr: "ignore",
		});
		return { child, ready: Promise.race([started.promise, child.exited.then(() => false)]) };
	};
	try {
		const install = await openInstallation(dir);
		const { createOwnerAccess } = await import("../services/owner/access");
		const access = createOwnerAccess(install);
		await access.claim(access.rotate(), "owner", crypto.randomUUID());
		await install.close();
		const first = launch("startup"),
			second = launch("startup");
		try {
			const ready = await Promise.all([first.ready, second.ready]);
			expect(ready.filter(Boolean)).toHaveLength(1);
			const blocked = launch("recovery");
			expect(await blocked.ready).toBe(false);
		} finally {
			first.child.kill("SIGKILL");
			second.child.kill("SIGKILL");
			await Promise.all([first.child.exited, second.child.exited]);
		}
		const exclusive = launch("recovery");
		try {
			expect(await exclusive.ready).toBe(true);
			const contender = launch("startup");
			expect(await contender.ready).toBe(false);
		} finally {
			exclusive.child.kill("SIGKILL");
			await exclusive.child.exited;
		}
		const reopened = await openInstallation(dir);
		await reopened.close();
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
}, 30000);

test("startup resumes an empty sidecar but refuses an unexpected schema or journal mode", async () => {
	const { Database } = await import("bun:sqlite");
	const { writeFile } = await import("node:fs/promises");
	const dir = await createOwnerDirectory(),
		path = join(dir, lockFilename);
	try {
		await writeFile(path, "", { mode: 0o600 });
		const install = await openInstallation(dir);
		await install.close();
		const sidecar = new Database(path);
		try {
			sidecar.exec("PRAGMA journal_mode=WAL");
		} finally {
			sidecar.close();
		}
		await expect(openInstallation(dir)).rejects.toThrow("lock unavailable");
		const changed = new Database(path);
		try {
			changed.exec("PRAGMA journal_mode=DELETE; CREATE TABLE unrelated(id INTEGER)");
		} finally {
			changed.close();
		}
		await expect(openInstallation(dir)).rejects.toThrow("lock unavailable");
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
});

test("exclusive recovery preserves the original owner on rollback and refuses an unrecognized database", async () => {
	const { sql } = await import("drizzle-orm");
	const { createOwnerAccess } = await import("../services/owner/access");
	const { recoverOwner } = await import("./recover-owner");
	const dir = await createOwnerDirectory();
	let install = await openInstallation(dir);
	try {
		const password = crypto.randomUUID();
		let access = createOwnerAccess(install);
		const session = await access.claim(access.rotate(), "owner", password);
		await install.close();
		install = await openInstallation(dir, "recovery");
		let checked = 0;
		await expect(
			recoverOwner(install, "unused replacement", () => {
				if (++checked === 2) throw new Error("Interrupted");
			}),
		).rejects.toThrow("Interrupted");
		await install.close();
		install = await openInstallation(dir);
		access = createOwnerAccess(install);
		expect(await access.session(session)).toBe("owner");
		expect((await access.signIn("owner", password)).kind).toBe("session");
		await install.use((db) => db.run(sql`CREATE TABLE unrelated(id INTEGER)`));
		await install.close();
		await expect(openInstallation(dir, "recovery")).rejects.toThrow("storage");
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
}, 30000);

test("startup recovers an interrupted sentinel transaction without replacing the sidecar", async () => {
	const directory = await createOwnerDirectory();
	const path = join(directory, lockFilename);
	const ready = Promise.withResolvers<void>();
	const child = Bun.spawn([process.execPath, "tests/fixtures/interrupt-sidecar.ts", path], {
		ipc: () => ready.resolve(),
	});
	try {
		await Promise.race([
			ready.promise,
			child.exited.then(() => {
				throw new Error("Bootstrap fixture stopped.");
			}),
		]);
		const { lstat } = await import("node:fs/promises");
		const before = await lstat(path, { bigint: true });
		child.kill("SIGKILL");
		await child.exited;
		await expect(openInstallation(directory, "recovery")).rejects.toThrow();
		const opened = await openInstallation(directory);
		try {
			expect((await lstat(path, { bigint: true })).ino).toBe(before.ino);
			expect(await opened.hasOwner()).toBe(false);
		} finally {
			await opened.close();
		}
	} finally {
		child.kill();
		await child.exited;
		await rm(directory, { recursive: true, force: true });
	}
}, 30000);
