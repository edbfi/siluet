import { sql } from "drizzle-orm";
import type { InstallationTransaction } from "./installation";

// https://docs.poyo.ai/api-manual/file-series/upload-stream
const windowMs = 60_000;
const limit = 10;
export const poyoUploadWindowSchema = "CREATE TABLE poyo_upload_start (started INTEGER NOT NULL)";

export async function nextPoyoUploadStart(tx: InstallationTransaction, now: number) {
	const blocked = await tx.get<{ until: number }>(sql`SELECT started+${windowMs} AS until
		FROM poyo_upload_start WHERE started>${now - windowMs} ORDER BY started DESC LIMIT 1 OFFSET ${limit - 1}`);
	return blocked?.until ?? 0;
}

export async function recordPoyoUploadStart(tx: InstallationTransaction, now: number) {
	await tx.run(sql`DELETE FROM poyo_upload_start WHERE started<=${now - windowMs}`);
	const row = await tx.get<{ id: number }>(
		sql`INSERT INTO poyo_upload_start(started) VALUES(${now}) RETURNING rowid AS id`,
	);
	if (!row) throw new Error("Upload start was not recorded.");
	return row.id;
}

export function undoPoyoUploadStart(tx: InstallationTransaction, id: number, time: number) {
	return tx.run(sql`DELETE FROM poyo_upload_start WHERE rowid=${id} AND started=${time}`);
}
