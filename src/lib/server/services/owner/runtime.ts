import type { EventEmitter } from "node:events";
import { homedir } from "node:os";
import { isAbsolute, join } from "node:path";
import { openInstallation } from "../../db/installation";
import { providerStore } from "../../db/provider-store";
import { checkPoyoConnection } from "../../providers/poyo/connection";
import { checkToapisConnection } from "../../providers/toapis/connection";
import { createProviderConnections } from "../providers/connections";
import { createOwnerAccess, rotationMs } from "./access";
import { studioOrigin } from "./origin";

export async function initializeOwner(dev: boolean) {
	const origin = studioOrigin(process.env, dev);
	const lifecycle: EventEmitter = process;
	if (!dev && !lifecycle.listenerCount("siluet:ready"))
		throw new Error("Start Siluet with bun run start.");
	const home = process.env.XDG_DATA_HOME;
	const directory =
		process.env.SILUET_DATA_DIR ??
		join(
			home && isAbsolute(home) ? home : join(homedir(), ".local", "share"),
			dev ? "siluet-dev" : "siluet",
		);
	const installation = await openInstallation(directory);
	const access = createOwnerAccess(installation);
	const providers = createProviderConnections(providerStore(installation), {
		poyo: checkPoyoConnection(),
		toapis: checkToapisConnection(),
	});
	let rotation: ReturnType<typeof setTimeout> | undefined;
	async function announce() {
		if (await installation.hasOwner()) return;
		console.info("Setup URL:", new URL("/setup", origin).href);
		console.info("Claim token:", access.rotate());
		rotation = setTimeout(
			() => void announce().catch(() => console.error("Unable to verify studio storage.")),
			rotationMs,
		).unref();
	}
	const ready = () =>
		void announce().catch(() => console.error("Unable to verify studio storage."));
	if (dev) await announce();
	else {
		lifecycle.once("sveltekit:shutdown", () => {
			clearTimeout(rotation);
			void installation.close().catch(() => console.error("Unable to close studio storage."));
		});
		lifecycle.emit("siluet:ready", ready);
	}
	return {
		origin,
		access,
		providers,
		hasOwner: installation.hasOwner,
		cookieName: `siluet_${installation.id}`,
	};
}
export type StudioRuntime = Awaited<ReturnType<typeof initializeOwner>>;
