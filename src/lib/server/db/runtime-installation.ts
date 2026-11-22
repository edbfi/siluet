import { realpath, stat } from "node:fs/promises";
import { type Installation, openInstallation } from "./installation";
import { preparePrivateDirectory } from "./private-directory";
import { providerKeyFilename } from "./provider-key";

/** Work that must settle before its installation closes, such as one preparation. */
export type RuntimeSlot = { readonly settled: Promise<void> };
type Entry = { preparation?: RuntimeSlot };

// The registry and brand survive module reloads, so a re-imported module sees the
// same claimed installation and the same held preparation slot.
const registry = Symbol.for("siluet.active-installations");
const brand: unique symbol = Symbol.for("siluet.runtime-installation");
const host = process as typeof process & { [registry]?: Map<string, Entry> };
host[registry] ??= new Map<string, Entry>();
const active = host[registry];

/** An installation holding both the process registry entry and Turso's file lock. */
export type RuntimeInstallation = Installation & { readonly [brand]: string };

export function isRuntimeInstallation(value: Installation): value is RuntimeInstallation {
	const identity = Reflect.get(value, brand);
	return typeof identity === "string" && active.has(identity);
}

/** The live registry entry for this installation. Throws once storage has closed. */
export function runtimeEntry(installation: RuntimeInstallation) {
	const entry = active.get(installation[brand]);
	if (!entry) throw new Error("Studio installation is closed.");
	return entry;
}

export async function openRuntimeInstallation(
	directory: string,
	env: NodeJS.ProcessEnv = process.env,
	mode: "startup" | "recovery" = "startup",
): Promise<RuntimeInstallation> {
	if (Object.hasOwn(env, "LIMBO_DISABLE_FILE_LOCK"))
		throw new Error("Studio requires the native file lock.");
	await preparePrivateDirectory(directory, providerKeyFilename, mode === "recovery");
	const path = await realpath(directory);
	const info = await stat(path, { bigint: true });
	const identity = info.ino
		? `${info.dev}:${info.ino}`
		: process.platform === "win32"
			? path.toLowerCase()
			: path;
	if (active.has(identity)) throw new Error("Studio installation is in use.");
	const entry: Entry = {};
	active.set(identity, entry);
	try {
		const installation = await openInstallation(path, mode);
		let closing: Promise<void> | undefined;
		return {
			...installation,
			[brand]: identity,
			close() {
				closing ??= (async () => {
					try {
						await entry.preparation?.settled;
						await installation.close();
					} finally {
						if (active.get(identity) === entry) active.delete(identity);
					}
				})();
				return closing;
			},
		};
	} catch (error) {
		active.delete(identity);
		throw error;
	}
}
