// Preload this file to run Siluet as if it were on another operating system.
import { writeFileSync } from "node:fs";

const platform = process.env.SILUET_TEST_PLATFORM;
if (platform) Object.defineProperty(process, "platform", { value: platform, configurable: true });
const sentinel = process.env.SILUET_TEST_SENTINEL;
if (sentinel)
	Object.defineProperty(Bun, "serve", {
		value: () => {
			writeFileSync(sentinel, "Bun.serve");
			throw new Error("A foreign platform reached Bun.serve.");
		},
	});
