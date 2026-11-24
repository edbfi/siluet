// Test-only: staged copies in a private scratch pool of an open runtime installation.
import type { RuntimeInstallation } from "../../db/runtime-installation";
import { createScratchPool } from "../media-staging/scratch";
import { createStages, type StageOptions } from "../media-staging/stages";

export async function openTestStages(installation: RuntimeInstallation, options?: StageOptions) {
	const pool = createScratchPool(installation);
	await pool.reclaim();
	return createStages(await pool.scope("image"), options);
}

/** A claim handle over fixed bytes, as the stage store hands one to the dispatcher. */
export const heldBytes = (bytes: Uint8Array<ArrayBuffer>, release = () => {}) => ({
	next: async () => bytes,
	release: async () => release(),
});
