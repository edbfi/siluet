import { lstat, readdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { connect } from "@tursodatabase/database";
import { sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/tursodatabase/database";
import { migrate } from "drizzle-orm/tursodatabase/wasm-migrator";

import { preparePrivateDirectory } from "./private-directory";

const migrationName = "20261121000000_owner_access";
const migrations = {
	[migrationName]: `CREATE TABLE installation (
		singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
		installation_id TEXT NOT NULL, claimed INTEGER NOT NULL CHECK (claimed IN (0, 1))
	);
	--> statement-breakpoint
	CREATE TABLE owner (
		id INTEGER PRIMARY KEY CHECK (id = 1), username TEXT NOT NULL,
		password_hash TEXT NOT NULL, created_at INTEGER NOT NULL
	);
	--> statement-breakpoint
	CREATE TABLE session (
		digest TEXT PRIMARY KEY NOT NULL, owner_id INTEGER NOT NULL REFERENCES owner(id),
		created_at INTEGER NOT NULL, last_activity INTEGER NOT NULL
	);
	--> statement-breakpoint
	CREATE TABLE auth_attempt (id TEXT PRIMARY KEY NOT NULL, kind TEXT NOT NULL, started INTEGER NOT NULL);`,
};

const storageError = () =>
	new Error("Studio storage could not be verified. Check the installation directory.");

export async function openInstallation(directory: string) {
	let client: Awaited<ReturnType<typeof connect>> | undefined;
	try {
		await preparePrivateDirectory(directory);
		const marker = join(directory, "installation.id");
		const database = join(directory, "studio.db");
		const fresh = (await readdir(directory)).length === 0;
		if (fresh) await writeFile(marker, crypto.randomUUID(), { flag: "wx", mode: 0o600 });
		if (!(await lstat(marker)).isFile() || (!fresh && !(await lstat(database)).isFile()))
			throw storageError();
		const id = await readFile(marker, "utf8");
		if (!/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(id))
			throw storageError();
		client = await connect(database, { fileMustExist: !fresh });
		const db = drizzle({ client });
		if (!fresh) {
			const applied = await db.all<{ name: string }>(
				sql`SELECT name FROM __drizzle_migrations ORDER BY id`,
			);
			if (applied.length !== 1 || applied[0].name !== migrationName) throw storageError();
		}
		await migrate(db, { migrations });
		if (fresh) {
			await db.run(
				sql`INSERT INTO installation(singleton, installation_id, claimed) VALUES (1, ${id}, 0)`,
			);
		}
		async function hasOwner() {
			const row = await db.get<{ installation_id: string; claimed: number; owners: number }>(
				sql`SELECT installation_id, claimed, (SELECT count(*) FROM owner) AS owners FROM installation WHERE singleton=1`,
			);
			if (
				!row ||
				row.installation_id !== id ||
				(row.claimed !== 0 && row.claimed !== 1) ||
				row.owners !== row.claimed
			)
				throw storageError();
			return row.claimed === 1;
		}
		await db.all(sql`SELECT digest, owner_id, created_at, last_activity FROM session LIMIT 0`);
		await db.all(sql`SELECT id, kind, started FROM auth_attempt LIMIT 0`);
		await db.all(sql`SELECT id, username, password_hash, created_at FROM owner LIMIT 0`);
		await hasOwner();
		const opened = client;
		// Keep work on this connection outside any other caller's open transaction.
		let tail = Promise.resolve();
		function use<T>(work: (connection: typeof db) => Promise<T>) {
			const result = tail.then(() => work(db));
			tail = result.then(
				() => {},
				() => {},
			);
			return result;
		}
		return { id, use, hasOwner: () => use(hasOwner), close: () => use(() => opened.close()) };
	} catch {
		await client?.close().catch(() => {});
		throw storageError();
	}
}
export type Installation = Awaited<ReturnType<typeof openInstallation>>;
