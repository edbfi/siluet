import panda from "@pandacss/vite";
import adapter from "@sveltejs/adapter-bun";
import { sveltekit } from "@sveltejs/kit/vite";
import { defineConfig } from "vite";

import { clientBudget } from "./scripts/bundle-budget.ts";
import { checkPublicAssets, guardPublicAssets } from "./scripts/public-assets.ts";

checkPublicAssets("static");

const bunAdapter = adapter({
	envPrefix: "SILUET_SERVER_",
	serverOptions: { hostname: "127.0.0.1" },
});

export default defineConfig({
	plugins: [
		guardPublicAssets("static"),
		sveltekit({
			adapter: bunAdapter,
			// Pages render dynamically, so SvelteKit adds a per-response nonce for its own
			// inline scripts and styles. The hook adds frame, sniffing and referrer headers.
			csp: {
				mode: "auto",
				directives: {
					"default-src": ["self"],
					"script-src": ["self"],
					"style-src": ["self"],
					// Style attributes only, never <style> elements: Svelte renders `style:`
					// directives with runtime values (Seedream and video frame sizes, setup
					// artwork) and its route announcer as attributes, and app.html wraps the
					// body in one. Hashes cannot cover runtime values. Attribute URLs still
					// obey img-src.
					"style-src-attr": ["unsafe-inline"],
					// data: for the Siluet icon, which Vite inlines as a small asset; blob: for
					// local image previews and for saved and staged images, fetched with the bearer.
					"img-src": ["self", "data:", "blob:"],
					// blob: for Gallery clips, which the page fetches with its bearer and plays from memory.
					"media-src": ["self", "blob:"],
					"object-src": ["none"],
					"base-uri": ["none"],
					"form-action": ["self"],
					"frame-ancestors": ["none"],
				},
			},
		}),
		panda({ transform: true }),
		clientBudget(),
	],
	server: {
		host: "127.0.0.1",
		port: 5173,
		strictPort: true,
		fs: {
			// fs.deny replaces Vite's defaults. Preserve its credential exclusions.
			deny: [
				".env",
				".env.*",
				"*.{crt,pem,key,p12,pfx,cer,der}",
				".npmrc",
				".yarnrc.yml",
				"**/.git/**",
				"studio.db",
				"studio.db-*",
				"owner-recovery.sqlite*",
				"installation.id",
			],
		},
	},
	ssr: { external: ["@tursodatabase/database"] },
});
