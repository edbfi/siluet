import { defineConfig } from "@pandacss/dev";

export default defineConfig({
	presets: ["@pandacss/preset-base"],
	include: ["./src/**/*.{ts,svelte}"],
	outdir: "styled-system",
});
