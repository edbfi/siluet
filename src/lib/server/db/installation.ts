import { lstat, readdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { connect } from "@tursodatabase/database";
import { sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/tursodatabase/database";
import { installationMigrations, migrateInstallation } from "./migrations";

import { DirectoryPolicyError, preparePrivateDirectory } from "./private-directory";
import { providerKeyFilename } from "./provider-key";

const storageError = () =>
	new Error(
		"Studio storage could not be verified. Check the installation directory. If initialization was interrupted, restore the installation backup or choose a new empty directory for a fresh setup.",
	);

export async function openInstallation(directory: string) {
	let client: Awaited<ReturnType<typeof connect>> | undefined;
	try {
		// The provider store checks its key before use and can report a reconnect.
		await preparePrivateDirectory(directory, providerKeyFilename);
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
		await migrateInstallation(db, fresh, installationMigrations);
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
		await db.all(
			sql`SELECT provider, revision, ciphertext, verified_at, seedream FROM provider_credential LIMIT 0`,
		);
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
		return {
			id,
			directory,
			use,
			hasOwner: () => use(hasOwner),
			close: () => use(() => opened.close()),
		};
	} catch (error) {
		await client?.close().catch(() => {});
		if (error instanceof DirectoryPolicyError) throw error;
		throw storageError();
	}
}
export type Installation = Awaited<ReturnType<typeof openInstallation>>;
