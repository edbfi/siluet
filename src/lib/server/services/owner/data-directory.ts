import { homedir } from "node:os";
import { isAbsolute, join } from "node:path";
export function ownerDirectory(dev = false) {
	const home = process.env.XDG_DATA_HOME;
	return (
		process.env.SILUET_DATA_DIR ??
		join(
			home && isAbsolute(home) ? home : join(homedir(), ".local", "share"),
			dev ? "siluet-dev" : "siluet",
		)
	);
}
