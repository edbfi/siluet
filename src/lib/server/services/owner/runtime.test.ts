import { afterEach, beforeEach, expect, spyOn, test } from "bun:test";
import type { EventEmitter } from "node:events";
import { rm } from "node:fs/promises";
import { createOwnerDirectory } from "../../../../../tests/fixtures/owner-directory";
import { initializeOwner } from "./runtime";

const keys = ["SILUET_DATA_DIR", "SILUET_SERVER_PORT", "SILUET_SERVER_ORIGIN"] as const;
const saved = keys.map((key) => process.env[key]);
let directory: string;

beforeEach(async () => {
	directory = await createOwnerDirectory();
	process.env.SILUET_DATA_DIR = directory;
	spyOn(console, "info").mockImplementation(() => {});
});
afterEach(async () => {
	for (const [index, key] of keys.entries()) {
		if (saved[index] === undefined) delete process.env[key];
		else process.env[key] = saved[index];
	}
	(console.info as unknown as { mockRestore(): void }).mockRestore();
	await rm(directory, { recursive: true, force: true });
});

test("a dev reload closes the previous runtime before opening the installation again", async () => {
	const first = await initializeOwner(true);
	// Vite re-evaluates hooks.server.ts and its imports in the same process.
	const reloaded: typeof import("./runtime") = await import(
		`./runtime.ts?reload=${crypto.randomUUID()}`
	);
	const second = await reloaded.initializeOwner(true);
	try {
		await expect(first.hasOwner()).rejects.toThrow();
		expect(await second.hasOwner()).toBe(false);
	} finally {
		await second.close();
	}
	const third = await initializeOwner(true);
	await third.close();
});

test("a started studio still refuses a second runtime in the same process", async () => {
	process.env.SILUET_SERVER_PORT = "5999";
	process.env.SILUET_SERVER_ORIGIN = "http://127.0.0.1:5999";
	const lifecycle: EventEmitter = process;
	const ready = () => {};
	lifecycle.on("siluet:ready", ready);
	try {
		const first = await initializeOwner(false);
		try {
			await expect(initializeOwner(false)).rejects.toThrow("Studio installation is in use.");
			expect(await first.hasOwner()).toBe(false);
		} finally {
			await first.close();
		}
	} finally {
		lifecycle.off("siluet:ready", ready);
		lifecycle.removeAllListeners("siluet:stopping");
		lifecycle.removeAllListeners("sveltekit:shutdown");
	}
});
