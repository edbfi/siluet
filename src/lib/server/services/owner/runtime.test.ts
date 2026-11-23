import { afterEach, beforeEach, expect, type Mock, mock, spyOn, test } from "bun:test";
import type { EventEmitter } from "node:events";
import { exists, rm } from "node:fs/promises";
import { join } from "node:path";
import { createOwnerDirectory } from "../../../../../tests/fixtures/owner-directory";
import * as runtimeInstallation from "../../db/runtime-installation";
import { UnsupportedPlatformError } from "../../platform";
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
	mock.restore();
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

test("a failed dev start leaves the next dev reload free to open", async () => {
	(console.info as Mock<typeof console.info>).mockImplementationOnce(() => {
		throw new Error("announce failed");
	});
	await expect(initializeOwner(true)).rejects.toThrow("announce failed");
	const next = await initializeOwner(true);
	expect(await next.hasOwner()).toBe(false);
	await next.close();
});

test("overlapping dev reloads close and open the runtime one at a time", async () => {
	const first = await initializeOwner(true);
	const [second, third] = await Promise.all([initializeOwner(true), initializeOwner(true)]);
	try {
		await expect(first.hasOwner()).rejects.toThrow();
		await expect(second.hasOwner()).rejects.toThrow();
		expect(await third.hasOwner()).toBe(false);
	} finally {
		await third.close();
	}
});

test("a dev reload still opens after the previous runtime failed to close", async () => {
	const error = spyOn(console, "error").mockImplementation(() => {});
	const open = runtimeInstallation.openRuntimeInstallation;
	spyOn(runtimeInstallation, "openRuntimeInstallation").mockImplementationOnce(async (...args) => {
		const installation = await open(...args);
		const close = installation.close;
		// Storage closes, then the close reports a failure.
		Object.assign(installation, {
			close: async () => {
				await close();
				throw new Error("close failed");
			},
		});
		return installation;
	});
	const first = await initializeOwner(true);
	// The reload's close of `first` rejects; it still opens, and so does the next.
	const second = await initializeOwner(true);
	await expect(first.close()).rejects.toThrow("close failed");
	expect(error.mock.calls).toEqual([["Unable to close the previous studio runtime."]]);
	const third = await initializeOwner(true);
	try {
		await expect(second.hasOwner()).rejects.toThrow();
		expect(await third.hasOwner()).toBe(false);
		expect(error.mock.calls).toHaveLength(1);
	} finally {
		await third.close();
	}
});

test("initializeOwner refuses a foreign platform before creating data", async () => {
	const data = join(directory, "siluet");
	const platform = Object.getOwnPropertyDescriptor(process, "platform");
	if (!platform) throw new Error("Expected process.platform.");
	process.env.SILUET_DATA_DIR = data;
	Object.defineProperty(process, "platform", { ...platform, value: "freebsd" });
	try {
		await expect(initializeOwner(false)).rejects.toThrow(UnsupportedPlatformError);
		expect(await exists(data)).toBe(false);
	} finally {
		Object.defineProperty(process, "platform", platform);
	}
});

test("startup settles an earlier runtime's file attempts by phase before ordinary recovery", async () => {
	const { openInstallation } = await import("../../db/installation");
	const { sql } = await import("drizzle-orm");
	const seeded = await openInstallation(directory);
	try {
		await seeded.use(async (db) => {
			const insert = (id: string, phase: string | null) =>
				db.run(sql`INSERT INTO image_job(id,binding,provider,revision,quote,state,model,created_at,poll_deadline,file_owner,file_phase)
					VALUES(${id},${id},'toapis',0,'{}','submitting','doubao-seedream-5-5',1,120001,${phase && "earlier"},${phase})`);
			await insert("claimed", "claimed");
			await insert("uploading", "uploading");
			await insert("uploaded", "uploaded");
			await insert("url", null);
		});
	} finally {
		await seeded.close();
	}
	const runtime = await initializeOwner(true);
	try {
		await runtime.checkAccess().catch(() => {});
		const jobs = Object.fromEntries(
			(await runtime.jobs.list()).map((job) => [job.id, [job.state, job.filePhase]]),
		);
		expect(jobs).toEqual({
			claimed: ["rejected", "unsent"],
			uploading: ["unknown", "upload-unknown"],
			uploaded: ["rejected", "stored"],
			url: ["unknown", undefined],
		});
	} finally {
		await runtime.close();
	}
});
