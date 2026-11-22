import { expect, test } from "bun:test";
import { readdir, rm } from "node:fs/promises";
import { createOwnerDirectory } from "../../../../tests/fixtures/owner-directory";
import { openInstallation } from "./installation";
import {
	isRuntimeInstallation,
	openRuntimeInstallation,
	runtimeEntry,
} from "./runtime-installation";

test("a refused second runtime leaves the native lock held until storage closes", async () => {
	const directory = await createOwnerDirectory();
	try {
		const first = await openRuntimeInstallation(directory);
		try {
			await expect(openRuntimeInstallation(directory)).rejects.toThrow("in use");
			// A reloaded module shares the process registry.
			const reloaded = await import(`./runtime-installation.ts?reload=${crypto.randomUUID()}`);
			await expect(reloaded.openRuntimeInstallation(directory)).rejects.toThrow("in use");
			expect(reloaded.runtimeEntry(first)).toBe(runtimeEntry(first));
			const entry = new URL("./runtime-installation.ts", import.meta.url).href;
			const child = Bun.spawn(
				[
					process.execPath,
					"-e",
					`import {openRuntimeInstallation} from ${JSON.stringify(entry)}; try { await openRuntimeInstallation(process.argv[1]); process.exit(2) } catch (error) { process.exit(error.message === "Studio installation is in use." ? 0 : 3) }`,
					directory,
				],
				{ stdout: "ignore", stderr: "ignore" },
			);
			expect(await child.exited).toBe(0);
		} finally {
			await first.close();
		}
		expect(() => runtimeEntry(first)).toThrow("closed");
		const reopened = await openRuntimeInstallation(directory);
		await reopened.close();
	} finally {
		await rm(directory, { recursive: true, force: true });
	}
});

test("lock contention → Studio installation is in use", async () => {
	const directory = await createOwnerDirectory();
	try {
		const first = await openRuntimeInstallation(directory);
		try {
			// POSIX locks are per process, so contention needs a second process.
			const entry = new URL("./installation.ts", import.meta.url).href;
			const child = Bun.spawn(
				[
					process.execPath,
					"-e",
					`import {openInstallation} from ${JSON.stringify(entry)}; try { await openInstallation(process.argv[1]); process.exit(2) } catch (error) { console.log(error.message) }`,
					directory,
				],
				{ stdout: "pipe", stderr: "ignore" },
			);
			expect((await new Response(child.stdout).text()).trim()).toBe(
				"Studio installation is in use.",
			);
			expect(await child.exited).toBe(0);
		} finally {
			await first.close();
		}
	} finally {
		await rm(directory, { recursive: true, force: true });
	}
});

test("only an open runtime installation carries the runtime brand", async () => {
	const directory = await createOwnerDirectory();
	try {
		const plain = await openInstallation(directory);
		expect(isRuntimeInstallation(plain)).toBeFalse();
		await plain.close();
		const runtime = await openRuntimeInstallation(directory);
		expect(isRuntimeInstallation(runtime)).toBeTrue();
		expect(isRuntimeInstallation({ ...plain })).toBeFalse();
		await runtime.close();
		expect(isRuntimeInstallation(runtime)).toBeFalse();
	} finally {
		await rm(directory, { recursive: true, force: true });
	}
});

test("closing waits for a held slot before releasing storage", async () => {
	const directory = await createOwnerDirectory();
	try {
		const runtime = await openRuntimeInstallation(directory);
		const slot = Promise.withResolvers<void>();
		runtimeEntry(runtime).preparation = { settled: slot.promise };
		let closed = false;
		const closing = runtime.close().then(() => {
			closed = true;
		});
		await Bun.sleep(20);
		expect(closed).toBeFalse();
		await expect(openRuntimeInstallation(directory)).rejects.toThrow("in use");
		slot.resolve();
		await closing;
		await (await openRuntimeInstallation(directory)).close();
	} finally {
		await rm(directory, { recursive: true, force: true });
	}
});

test("even an empty file lock override refuses initialization before creating storage", async () => {
	const directory = await createOwnerDirectory();
	try {
		await expect(
			openRuntimeInstallation(directory, { LIMBO_DISABLE_FILE_LOCK: "" }),
		).rejects.toThrow("file lock");
		expect(await readdir(directory)).toEqual([]);
	} finally {
		await rm(directory, { recursive: true, force: true });
	}
});
