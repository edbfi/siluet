import { createHmac } from "node:crypto";
import { sql } from "drizzle-orm";
import type { Installation } from "../../db/installation";

export const tokenFormat = /^([a-f0-9-]{36})\.([a-f0-9]{64})\.([a-f0-9]{64})$/;
export async function reviewSigner(installation: Installation) {
	const stored = await installation.use((db) =>
		db.get<{ secret: string }>(sql`SELECT secret FROM image_review_key WHERE singleton=1`),
	);
	if (!stored || !/^[0-9a-f]{64}$/i.test(stored.secret))
		throw new Error("Review signing key unavailable.");
	const key = Buffer.from(stored.secret, "hex");
	return (...fields: unknown[]) =>
		createHmac("sha256", key).update(JSON.stringify(fields)).digest("hex");
}
