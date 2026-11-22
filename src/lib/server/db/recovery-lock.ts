import { Database } from "bun:sqlite";
import { lstat, open } from "node:fs/promises";
import { join } from "node:path";
import { DirectoryPolicyError } from "./private-directory";

export const lockFilename = "owner-recovery.sqlite";
const sentinel = "CREATE TABLE recovery_lock (version INTEGER PRIMARY KEY CHECK(version=1))";
const unavailable = () =>
	new DirectoryPolicyError(
		"Studio recovery lock unavailable. Stop all studio processes. For an older backup, start the installed version once, then stop it before recovery.",
	);

async function inspect(path: string) {
	try {
		const file = await lstat(path);
		if (!file.isFile() || file.nlink !== 1 || file.uid !== process.getuid?.() || file.mode & 0o077)
			throw unavailable();
		return true;
	} catch (e) {
		if (e instanceof Error && "code" in e && e.code === "ENOENT") return false;
		throw e;
	}
}

export async function acquireRecoveryLock(directory: string, recovery: boolean) {
	const path = join(directory, lockFilename);
	let db: Database | undefined;
	try {
		if (!(await inspect(path))) {
			if (recovery) throw unavailable();
			try {
				await (await open(path, "wx", 0o600)).close();
			} catch (e) {
				if (!(e instanceof Error && "code" in e && e.code === "EEXIST")) throw e;
			}
			if (!(await inspect(path))) throw unavailable();
		}
		if ((await inspect(`${path}-wal`)) || (await inspect(`${path}-shm`))) throw unavailable();
		await inspect(`${path}-journal`);
		db = new Database(path, { readwrite: true, create: false });
		db.exec("PRAGMA busy_timeout=0");
		if (
			db.query<{ journal_mode: string }, []>("PRAGMA journal_mode").get()?.journal_mode !== "delete"
		)
			throw unavailable();
		const schema = db.query<{ sql: string }, []>("SELECT sql FROM sqlite_schema ORDER BY name");
		db.exec(recovery ? "BEGIN EXCLUSIVE" : "BEGIN");
		if (!schema.all().length && !recovery) {
			db.exec("ROLLBACK; BEGIN EXCLUSIVE");
			if (!schema.all().length) db.exec(`${sentinel}; INSERT INTO recovery_lock VALUES (1)`);
			db.exec("COMMIT; BEGIN");
		}
		const entries = schema.all();
		if (
			entries.length !== 1 ||
			entries[0]?.sql !== sentinel ||
			db.query<{ version: number }, []>("SELECT version FROM recovery_lock").get()?.version !== 1
		)
			throw unavailable();
		return db;
	} catch {
		db?.close();
		throw unavailable();
	}
}
