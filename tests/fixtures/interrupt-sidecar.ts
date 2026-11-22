import { Database } from "bun:sqlite";
import { open } from "node:fs/promises";

const path = process.argv[2];
await (await open(path, "wx", 0o600)).close();
const db = new Database(path, { readwrite: true, create: false });
db.exec(
	"BEGIN EXCLUSIVE; CREATE TABLE recovery_lock(version INTEGER PRIMARY KEY); INSERT INTO recovery_lock VALUES(1)",
);
process.send?.("initializing");
process.on("message", () => db.close());
