import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

export function createOwnerDirectory(prefix = "siluet-owner-") {
	return mkdtemp(join(tmpdir(), prefix));
}
