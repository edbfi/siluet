import panda from "@pandacss/vite";
import adapter from "@sveltejs/adapter-bun";
import { sveltekit } from "@sveltejs/kit/vite";
import { defineConfig } from "vite";

export default defineConfig({
	plugins: [
		sveltekit({
			adapter: adapter({
				envPrefix: "SILUET_SERVER_",
				serverOptions: { hostname: "127.0.0.1" },
			}),
		}),
		panda({ transform: true }),
	],
	server: { host: "127.0.0.1" },
});
