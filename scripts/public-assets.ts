import { lstatSync, readdirSync } from "node:fs";
import { join } from "node:path";
import type { Plugin } from "vite";

// Vite copies the public tree verbatim, outside its dev-server fs.deny policy.
export function checkPublicAssets(root: string) {
	function visit(path: string, name: string) {
		const entry = lstatSync(path);
		if (entry.isSymbolicLink() || /^(?:installation\.id|studio\.db(?:-.*)?)$/i.test(name))
			throw new Error("Public assets must exclude filesystem links and owner storage files.");
		if (entry.isDirectory()) for (const child of readdirSync(path)) visit(join(path, child), child);
	}
	if (lstatSync(root, { throwIfNoEntry: false })) visit(root, "");
}

// SvelteKit handles public files before its application hook. Run this check
// ahead of that handler as the public tree can change while Vite is running.
export function guardPublicAssets(root: string): Plugin {
	return {
		name: "siluet-private-storage",
		enforce: "pre",
		configureServer(server) {
			server.middlewares.use((_req, res, next) => {
				try {
					checkPublicAssets(root);
				} catch {
					res.writeHead(403, { "cache-control": "no-store" });
					res.end("Public asset configuration is unsafe.");
					return;
				}
				next();
			});
		},
	};
}
