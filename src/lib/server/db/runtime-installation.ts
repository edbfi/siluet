import { stat } from "node:fs/promises";
import { type Installation, openInstallation } from "./installation";
import { preparePrivateDirectory } from "./private-directory";

/** Work that must settle before its installation closes, such as one preparation. */
export type RuntimeSlot = { readonly settled: Promise<void> };
type Entry = { readonly identity: string; preparation?: RuntimeSlot };

// The registry and brand survive module reloads, so a re-imported module sees the
// same claimed installation and the same held preparation slot.
const registry = Symbol.for("siluet.active-installations");
const brand: unique symbol = Symbol.for("siluet.runtime-installation");
const host = process as typeof process & { [registry]?: Map<string, Entry> };
host[registry] ??= new Map<string, Entry>();
const active = host[registry];

/**
 * An installation holding both the process registry entry and Turso's file lock.
 * The brand is that exact entry, so a handle from before a reopen stays invalid.
 */
export type RuntimeInstallation = Installation & { readonly [brand]: Entry };

function live(entry: unknown): entry is Entry {
	return (
		typeof entry === "object" &&
		entry !== null &&
		"identity" in entry &&
		typeof entry.identity === "string" &&
		active.get(entry.identity) === entry
	);
}

export function isRuntimeInstallation(value: Installation): value is RuntimeInstallation {
	return live(Reflect.get(value, brand));
}

/** The live registry entry for this installation. Throws once storage has closed. */
export function runtimeEntry(installation: RuntimeInstallation) {
	const entry = installation[brand];
	if (!live(entry)) throw new Error("Studio installation is closed.");
	return entry;
}

export async function openRuntimeInstallation(
	directory: string,
	env: NodeJS.ProcessEnv = process.env,
	mode: "startup" | "recovery" = "startup",
): Promise<RuntimeInstallation> {
	if (Object.hasOwn(env, "LIMBO_DISABLE_FILE_LOCK"))
		throw new Error("Studio requires the native file lock.");
	const path = await preparePrivateDirectory(directory, mode === "recovery");
	const info = await stat(path, { bigint: true });
	const identity = info.ino ? `${info.dev}:${info.ino}` : path;
	if (active.has(identity)) throw new Error("Studio installation is in use.");
	const entry: Entry = { identity };
	active.set(identity, entry);
	try {
		const installation = await openInstallation(path, mode);
		let closing: Promise<void> | undefined;
		return {
			...installation,
			[brand]: entry,
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
