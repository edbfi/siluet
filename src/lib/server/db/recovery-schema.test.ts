import { expect, test } from "bun:test";
import { connect } from "@tursodatabase/database";
import { drizzle } from "drizzle-orm/tursodatabase/database";
import { installationMigrations, migrateInstallation } from "./migrations";
import { verifyRecoverySchema } from "./recovery-schema";

test("the migration chain on an empty database produces the recorded schema", async () => {
	const client = await connect(":memory:");
	try {
		const db = drizzle({ client });
		await migrateInstallation(db, true, installationMigrations);
		await expect(verifyRecoverySchema(db)).resolves.toBeUndefined();
	} finally {
		await client.close();
	}
});
