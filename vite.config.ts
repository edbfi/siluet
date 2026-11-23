import { copyFile } from "node:fs/promises";
import panda from "@pandacss/vite";
import adapter from "@sveltejs/adapter-bun";
import { sveltekit } from "@sveltejs/kit/vite";
import { defineConfig } from "vite";

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
			adapter: {
				...bunAdapter,
				async adapt(builder) {
					await bunAdapter.adapt(builder);
					await copyFile("tests/fixtures/video/h264-aac.mp4", "build/server/qualification.mp4");
				},
			},
		}),
		panda({ transform: true }),
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
				"installation.id",
			],
		},
	},
	ssr: { external: ["@tursodatabase/database"] },
});
