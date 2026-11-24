import { sql } from "drizzle-orm";
import type { InstallationTransaction } from "./installation";

// https://docs.poyo.ai/api-manual/file-series/upload-stream
const windowMs = 60_000;
const limit = 10;
export const poyoUploadWindowSchema = "CREATE TABLE poyo_upload_start (started INTEGER NOT NULL)";

/** When `needed` more uploads (1–10) fit the account's rolling window; 0 when they fit now. */
export async function nextPoyoUploadStart(
	tx: Pick<InstallationTransaction, "get">,
	now: number,
	needed = 1,
) {
	if (!Number.isInteger(needed) || needed < 1 || needed > limit)
		throw new Error("Upload count outside the Poyo.ai window.");
	const blocked = await tx.get<{ until: number }>(sql`SELECT started+${windowMs} AS until
		FROM poyo_upload_start WHERE started>${now - windowMs} ORDER BY started DESC LIMIT 1 OFFSET ${limit - needed}`);
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
