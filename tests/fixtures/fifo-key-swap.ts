// Run alone: replace the provider key with a FIFO between its checks and its open, then
// print how reading it ended. A blocking open would never return.
import { mock } from "bun:test";
import * as fs from "node:fs/promises";
import { join } from "node:path";

const directory = process.argv[2];
const real = { ...fs };
mock.module("node:fs/promises", () => ({
	...real,
	open: async (path: string, ...rest: [number, number?]) => {
		if (path.endsWith(".key")) {
			await real.rm(path);
			Bun.spawnSync(["mkfifo", "-m", "600", path]);
		}
		return real.open(path, ...rest);
	},
}));
const { readProviderKey, providerKeyFilename } = await import(
	"../../src/lib/server/db/provider-key"
);
await fs.writeFile(join(directory, providerKeyFilename), Buffer.alloc(32), { mode: 0o600 });
const outcome = await Promise.race([
	readProviderKey(directory).then(
		() => "read",
		(error: Error) => error.constructor.name,
	),
	Bun.sleep(3000).then(() => "blocked"),
]);
console.log(outcome);
process.exit(0);
