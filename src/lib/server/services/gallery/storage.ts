import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { lstat, open, readdir, rm } from "node:fs/promises";
import { join } from "node:path";
import { sql } from "drizzle-orm";
import type { Installation } from "../../db/installation";
import type { verifyImage } from "./verify-image";

type ImageInfo = Awaited<ReturnType<typeof verifyImage>>;
type Row = ImageInfo & {
	job_id: string;
	state: "saved" | "deleting" | "unavailable";
	size: number;
	digest: string;
	saved_at: number;
};
type Connection = Parameters<Parameters<Installation["use"]>[0]>[0];
type Write = Parameters<Parameters<Connection["transaction"]>[0]>[0];
const hash = (value: Buffer | string) => createHash("sha256").update(value).digest("hex");
const filename = (id: string) => `gallery-${hash(id)}`;
const rowQuery = (id: string) => sql`SELECT * FROM gallery_image WHERE job_id=${id}`;
const absent = (error: unknown) =>
	error instanceof Error && "code" in error && (error.code === "ENOENT" || error.code === "ELOOP");

async function syncDirectory(path: string) {
	// Windows does not support opening a directory for fsync via Node's fs API.
	if (process.platform === "win32") return;
	const handle = await open(path, "r");
	try {
		await handle.sync();
	} finally {
		await handle.close();
	}
}

export function galleryStorage({ directory, use }: Installation) {
	const pathFor = (id: string) => join(directory, filename(id));
	const locked = <T>(work: (tx: Write) => Promise<T>) =>
		use((db) => db.transaction(work, { behavior: "immediate" }));

	async function markUnavailable(db: Pick<Connection, "run">, row: Row) {
		await db.run(sql`UPDATE gallery_image SET state='unavailable' WHERE job_id=${row.job_id}
			AND state='saved' AND saved_at=${row.saved_at} AND digest=${row.digest}`);
	}
	async function entry(db: Pick<Connection, "run">, row: Row) {
		let available = row.state === "saved";
		if (available) {
			try {
				const stat = await lstat(pathFor(row.job_id));
				available = stat.isFile() && stat.size === row.size;
			} catch (error) {
				if (!absent(error)) throw error;
				available = false;
			}
			if (!available) await markUnavailable(db, row);
		}
		return {
			jobId: row.job_id,
			mime: row.mime,
			savedAt: row.saved_at,
			width: row.width,
			height: row.height,
			available,
		};
	}
	async function finishRemoval(tx: Write, id: string) {
		await rm(pathFor(id), { force: true });
		await syncDirectory(directory);
		await tx.run(sql`DELETE FROM gallery_image WHERE job_id=${id} AND state='deleting'`);
	}

	return {
		async recover() {
			await locked(async (tx) => {
				const rows = await tx.all<Row>(sql`SELECT * FROM gallery_image`);
				const published = new Set<string>();
				for (const row of rows) {
					if (row.state === "deleting") await finishRemoval(tx, row.job_id);
					else if ((await entry(tx, row)).available) published.add(filename(row.job_id));
				}
				for (const file of await readdir(directory, { withFileTypes: true })) {
					if (
						(file.isFile() || file.isSymbolicLink()) &&
						/^gallery-[a-f0-9]{64}$/.test(file.name) &&
						!published.has(file.name)
					)
						await rm(join(directory, file.name), { force: true });
				}
			});
		},
		list() {
			return use(async (db) => {
				const rows = await db.all<Row>(
					sql`SELECT * FROM gallery_image WHERE state != 'deleting' ORDER BY saved_at DESC, job_id`,
				);
				const entries = [];
				for (const row of rows) entries.push(await entry(db, row));
				return entries;
			});
		},
		get(id: string) {
			return use(async (db) => {
				const row = await db.get<Row>(rowQuery(id));
				return row && row.state !== "deleting" ? entry(db, row) : null;
			});
		},
		markUnsupported(id: string) {
			return use((db) =>
				db.run(sql`UPDATE image_job SET gallery_reason='unsupported-image'
				WHERE id=${id} AND state='completed' AND NOT EXISTS (
					SELECT 1 FROM gallery_image WHERE job_id=${id} AND state='saved'
				)`),
			);
		},
		publish(id: string, bytes: Buffer, info: ImageInfo) {
			return locked(async (tx) => {
				const row = await tx.get<Row>(rowQuery(id));
				if (row?.state === "deleting") return false;
				if (row && (await entry(tx, row)).available) return true;
				const path = pathFor(id);
				// The write transaction excludes another publisher and the startup sweep.
				// Clear a partial write from an interrupted Save before reusing this name.
				await rm(path, { force: true });
				const file = await open(path, "wx", 0o600);
				try {
					try {
						await file.writeFile(bytes);
						await file.sync();
					} finally {
						await file.close();
					}
					await syncDirectory(directory);
					await tx.run(sql`INSERT OR REPLACE INTO gallery_image
						(job_id,state,mime,width,height,size,digest,saved_at) VALUES
						(${id},'saved',${info.mime},${info.width},${info.height},${bytes.length},${hash(bytes)},${Date.now()})`);
					await tx.run(sql`UPDATE image_job SET gallery_reason=NULL WHERE id=${id}`);
					return true;
				} catch (error) {
					await rm(path, { force: true });
					throw error;
				}
			});
		},
		read(id: string) {
			return use(async (db) => {
				const row = await db.get<Row>(rowQuery(id));
				if (row?.state !== "saved") return null;
				try {
					const file = await open(
						pathFor(id),
						constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
					);
					try {
						const info = await file.stat();
						if (info.isFile() && info.size === row.size) {
							const bytes = await file.readFile();
							if (hash(bytes) === row.digest) return { mime: row.mime, bytes };
						}
					} finally {
						await file.close();
					}
				} catch (error) {
					if (!absent(error)) throw error;
				}
				await markUnavailable(db, row);
				return null;
			});
		},
		async remove(id: string) {
			// Commit deletion intent before unlink. Recovery completes either remaining step.
			await use((db) => db.run(sql`UPDATE gallery_image SET state='deleting' WHERE job_id=${id}`));
			return locked(async (tx) => {
				const row = await tx.get<Row>(rowQuery(id));
				if (row?.state !== "deleting") return false;
				await finishRemoval(tx, id);
				return true;
			});
		},
	};
}
