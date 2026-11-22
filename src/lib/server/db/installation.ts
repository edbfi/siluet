import { lstat, readdir, readFile, realpath, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { connect } from "@tursodatabase/database";
import { sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/tursodatabase/database";
import { requireSupportedPlatform, UnsupportedPlatformError } from "../platform";
import { installationMigrations, migrateInstallation } from "./migrations";

import { DirectoryPolicyError, preparePrivateDirectory } from "./private-directory";
import { providerKeyFilename } from "./provider-key";
import { acquireRecoveryLock, lockFilename } from "./recovery-lock";
import { verifyRecoverySchema } from "./recovery-schema";

const storageError = () =>
	new Error(
		"Studio storage could not be verified. Check the installation directory. If initialization was interrupted, restore the installation backup or choose a new empty directory for a fresh setup.",
	);

export async function openInstallation(
	directory: string,
	mode: "startup" | "recovery" = "startup",
) {
	const recovery = mode === "recovery";
	let lock: Awaited<ReturnType<typeof acquireRecoveryLock>> | undefined;
	let client: Awaited<ReturnType<typeof connect>> | undefined;
	requireSupportedPlatform();
	try {
		// The provider store checks its key before use and can report a reconnect.
		await preparePrivateDirectory(directory, providerKeyFilename, recovery);
		directory = await realpath(directory);
		const marker = join(directory, "installation.id");
		const database = join(directory, "studio.db");
		const contents = await readdir(directory);
		if (
			!recovery &&
			contents.some((name) => name !== lockFilename && name !== `${lockFilename}-journal`) &&
			!contents.includes("installation.id")
		)
			throw storageError();
		lock = await acquireRecoveryLock(directory, recovery);
		const fresh = !recovery && (await readdir(directory)).every((name) => name === lockFilename);
		if (fresh) await writeFile(marker, crypto.randomUUID(), { flag: "wx", mode: 0o600 });
		if (!(await lstat(marker)).isFile() || (!fresh && !(await lstat(database)).isFile()))
			throw storageError();
		const id = await readFile(marker, "utf8");
		if (!/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(id))
			throw storageError();
		// The embedded Turso driver waits for a competing writer for at most 500 ms.
		client = await connect(database, { fileMustExist: !fresh, timeout: 500 });
		const db = drizzle({ client });
		if (recovery) await verifyRecoverySchema(db);
		else await migrateInstallation(db, fresh, installationMigrations);
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
		if (!(await hasOwner()) && recovery) throw storageError();
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
			mode,
			use,
			hasOwner: () => use(hasOwner),
			close: () =>
				use(async () => {
					await opened.close();
					lock?.close();
				}),
		};
	} catch (error) {
		await client?.close().catch(() => {});
		lock?.close();
		// Turso holds an exclusive process lock on studio.db while a runtime has it open.
		// https://github.com/tursodatabase/turso/blob/v0.8.3/core/io/unix.rs
		if (
			error instanceof Error &&
			/Locking error: Failed locking file|locked by another process/i.test(error.message)
		)
			throw new DirectoryPolicyError("Studio installation is in use.");
		if (error instanceof DirectoryPolicyError || error instanceof UnsupportedPlatformError)
			throw error;
		throw storageError();
	}
}
export type Installation = Awaited<ReturnType<typeof openInstallation>> & {
	/** Committed owner changes report the session digests they removed. */
	retireSessions?: (digests: ReadonlySet<string>) => void;
};
export type StudioDatabase = Parameters<Parameters<Installation["use"]>[0]>[0];
export type InstallationTransaction = Parameters<Parameters<StudioDatabase["transaction"]>[0]>[0];
export type OwnerTransaction = InstallationTransaction;
