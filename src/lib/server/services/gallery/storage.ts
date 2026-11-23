import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { type FileHandle, lstat, open, readdir, rename, rm } from "node:fs/promises";
import { join } from "node:path";
import { type SQL, sql } from "drizzle-orm";
import type { Installation } from "../../db/installation";
import type { verifyImage } from "./verify-image";

type Update = (statement: SQL) => Promise<unknown>;
type ImageInfo = Awaited<ReturnType<typeof verifyImage>>;
type Row = Omit<ImageInfo, "mime"> & {
	mime: ImageInfo["mime"] | "video/mp4";
	duration: number | null;
	file_identity: string | null;
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

const identity = (s: { dev: bigint; ino: bigint; ctimeNs: bigint }) =>
	[s.dev, s.ino, s.ctimeNs].join("/");

async function matchesSavedBytes(handle: FileHandle, row: Row) {
	const digest = createHash("sha256");
	const buffer = Buffer.allocUnsafe(65536);
	let offset = 0;
	while (offset < row.size) {
		const { bytesRead } = await handle.read(
			buffer,
			0,
			Math.min(buffer.length, row.size - offset),
			offset,
		);
		if (!bytesRead) return false;
		digest.update(buffer.subarray(0, bytesRead));
		offset += bytesRead;
	}
	return digest.digest("hex") === row.digest;
}

async function syncDirectory(path: string) {
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

	const liveUpdate: Update = (statement) => use((db) => db.get(statement));
	async function markUnavailable(update: Update, row: Row) {
		await update(sql`UPDATE gallery_image SET state='unavailable' WHERE job_id=${row.job_id}
			AND state='saved' AND saved_at=${row.saved_at} AND digest=${row.digest} AND file_identity IS ${row.file_identity}`);
	}
	async function checkedVideo(update: Update, row: Row, metadataOnly = false) {
		try {
			const handle = await open(
				pathFor(row.job_id),
				constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
			);
			let valid = false;
			try {
				const stat = await handle.stat({ bigint: true });
				if (stat.isFile() && stat.size === BigInt(row.size)) {
					const signature = identity(stat);
					valid = signature === row.file_identity;
					if (!valid) {
						// HEAD cannot read payload. GET or Gallery reconciliation can verify changed metadata.
						if (metadataOnly) return null;
						const matches = await matchesSavedBytes(handle, row);
						if (identity(await handle.stat({ bigint: true })) !== signature) {
							throw new Error("The saved video changed during verification.");
						}
						if (matches) {
							valid = Boolean(
								await update(sql`UPDATE gallery_image SET file_identity=${signature} WHERE job_id=${row.job_id}
								AND state='saved' AND saved_at=${row.saved_at} AND digest=${row.digest} AND file_identity IN (${row.file_identity},${signature}) RETURNING 1`),
							);
							if (!valid) return null;
						}
					}
				}
				if (valid) return { handle, size: row.size };
			} finally {
				if (!valid) await handle.close();
			}
		} catch (error) {
			if (!absent(error)) throw error;
		}
		await markUnavailable(update, row);
		return null;
	}
	async function entry(update: Update, row: Row) {
		let available = row.state === "saved";
		if (available && row.mime === "video/mp4") {
			const video = await checkedVideo(update, row);
			available = Boolean(video);
			await video?.handle.close();
		} else if (available) {
			try {
				const stat = await lstat(pathFor(row.job_id), { bigint: true });
				available = stat.isFile() && stat.size === BigInt(row.size);
			} catch (error) {
				if (!absent(error)) throw error;
				available = false;
			}
			if (!available) await markUnavailable(update, row);
		}
		return {
			jobId: row.job_id,
			mime: row.mime,
			savedAt: row.saved_at,
			...(row.mime === "video/mp4" && { duration: row.duration }),
			width: row.width,
			height: row.height,
			available,
		};
	}
	// The caller reconciles existing clips before publication. If another clip has
	// appeared since then, verify its cached identity without hashing under the write lock.
	async function existingPublication(tx: Write, row: Row | undefined) {
		if (row?.state === "deleting") return false;
		if (row?.state !== "saved") return;
		const update: Update = (statement) => tx.get(statement);
		if (row.mime === "video/mp4") {
			const video = await checkedVideo(update, row, true);
			await video?.handle.close();
			return Boolean(video);
		}
		if ((await entry(update, row)).available) return true;
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
					else if ((await entry((statement) => tx.get(statement), row)).available)
						published.add(filename(row.job_id));
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
		async list() {
			const rows = await use((db) =>
				db.all<Row>(
					sql`SELECT * FROM gallery_image WHERE state != 'deleting' ORDER BY saved_at DESC, job_id`,
				),
			);
			const entries = [];
			for (const row of rows) entries.push(await entry(liveUpdate, row));
			return entries;
		},
		async get(id: string) {
			const row = await use((db) => db.get<Row>(rowQuery(id)));
			return row && row.state !== "deleting" ? entry(liveUpdate, row) : null;
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
				const existing = await existingPublication(tx, await tx.get<Row>(rowQuery(id)));
				if (existing !== undefined) return existing;
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
		publishVideo(
			id: string,
			scratch: string,
			token: string,
			info: { duration: number; width: number; height: number; size: number; digest: string },
		) {
			return locked(async (tx) => {
				if (
					!(await tx.get(
						sql`SELECT 1 FROM video_save WHERE token=${token} AND job_id=${id} AND cancelled=0`,
					))
				)
					return false;
				const existing = await existingPublication(tx, await tx.get<Row>(rowQuery(id)));
				if (existing !== undefined) return existing;
				const path = pathFor(id);
				await rename(scratch, path);
				try {
					const signature = identity(await lstat(path, { bigint: true }));
					await syncDirectory(directory);
					await tx.run(sql`INSERT OR REPLACE INTO gallery_image
						(job_id,state,mime,width,height,size,digest,saved_at,duration,file_identity)
						VALUES (${id},'saved','video/mp4',${info.width},${info.height},${info.size},${info.digest},${Date.now()},${info.duration},${signature})`);
					return true;
				} catch (error) {
					await rm(path, { force: true });
					throw error;
				}
			});
		},
		async openVideo(id: string, metadataOnly = false) {
			const row = await use((db) => db.get<Row>(rowQuery(id)));
			return row?.state === "saved" && row.mime === "video/mp4"
				? checkedVideo(liveUpdate, row, metadataOnly)
				: null;
		},
		read(id: string) {
			return use(async (db) => {
				const row = await db.get<Row>(rowQuery(id));
				if (row?.state !== "saved" || row.mime === "video/mp4") return null;
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
				await markUnavailable((statement) => db.get(statement), row);
				return null;
			});
		},
		async remove(id: string) {
			// Commit deletion intent before unlink. Recovery completes either remaining step.
			await locked(async (tx) => {
				await tx.run(sql`UPDATE video_save SET cancelled=1 WHERE job_id=${id}`);
				await tx.run(sql`UPDATE gallery_image SET state='deleting' WHERE job_id=${id}`);
			});
			return locked(async (tx) => {
				const row = await tx.get<Row>(rowQuery(id));
				if (row?.state !== "deleting") return false;
				await finishRemoval(tx, id);
				return true;
			});
		},
	};
}
