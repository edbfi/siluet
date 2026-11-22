import { expect, spyOn, test } from "bun:test";
import { randomBytes, randomUUID } from "node:crypto";
import { chmod, link, rm, unlink } from "node:fs/promises";
import { join } from "node:path";
import { Writable } from "node:stream";
import { createOwnerDirectory } from "../../../../tests/fixtures/owner-directory";
import { KeyViolation, publishFactorKey, readFactorKey } from "./factor-key";

test("publication is exclusive and read rejects missing and multiply linked keys", async () => {
	const dir = await createOwnerDirectory();
	const id = randomUUID();
	const key = randomBytes(32);
	try {
		await expect(readFactorKey(dir, id)).rejects.toBeInstanceOf(KeyViolation);
		await publishFactorKey(dir, id, key);
		await expect(publishFactorKey(dir, id, randomBytes(32))).rejects.toThrow();
		expect(await readFactorKey(dir, id)).toEqual(key);
		const path = join(dir, `factor-${id}.key`);
		await link(path, join(dir, "second"));
		await expect(readFactorKey(dir, id)).rejects.toBeInstanceOf(KeyViolation);
		await unlink(join(dir, "second"));
		if (process.platform !== "win32") {
			await chmod(path, 0o644);
			await expect(readFactorKey(dir, id)).rejects.toBeInstanceOf(KeyViolation);
		}
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
});

test("temporary key lookup failures retry; a verified envelope mismatch remains closed after restart", async () => {
	const { openInstallation } = await import("./installation");
	const { checkedSecurity } = await import("./security-state");
	const { createOwnerAccess } = await import("../services/owner/access");
	const { TOTP } = await import("otpauth");
	const directory = await createOwnerDirectory();
	let install = await openInstallation(directory);
	try {
		const password = randomUUID();
		const access = createOwnerAccess(install);
		const session = await access.claim(access.rotate(), "owner", password);
		const grant = await access.security.authorize("enable", session, password, "");
		if (grant.kind !== "candidate") throw new Error();
		await access.security.activate(
			"enable",
			session,
			grant.proof,
			new TOTP({ secret: grant.manual }).generate(),
		);
		await expect(
			checkedSecurity(install, async () => {
				throw new Error("Temporary fixture");
			}),
		).rejects.toThrow("Retry");
		const checked = await checkedSecurity(install);
		expect(checked.factor).toBeTruthy();
		await expect(checkedSecurity(install, async () => randomBytes(32))).rejects.toThrow(
			"owner:recover",
		);
		await install.close();
		install = await openInstallation(directory);
		await expect(checkedSecurity(install)).rejects.toThrow("owner:recover");
	} finally {
		await install.close();
		await rm(directory, { recursive: true, force: true });
	}
}, 30000);

test("a stopped publication leaves only its unique unreferenced file and preserves the active key", async () => {
	const directory = await createOwnerDirectory();
	const active = randomUUID(),
		key = randomBytes(32);
	try {
		await publishFactorKey(directory, active, key);
		const harness = join(directory, "InterruptPublication.exe");
		if (process.platform === "win32") {
			const root = process.env.SystemRoot;
			if (!root) throw new Error("Missing Windows system directory.");
			const compiler = join(root, "Microsoft.NET", "Framework64", "v4.0.30319", "csc.exe");
			const compiled = Bun.spawnSync([
				compiler,
				"/nologo",
				"/target:exe",
				"/main:InterruptPublication",
				`/out:${harness}`,
				join(process.cwd(), "native", "FactorKey.cs"),
				join(process.cwd(), "tests", "fixtures", "InterruptPublication.cs"),
			]);
			expect(compiled.exitCode).toBe(0);
		}
		for (const stage of ["before-create", "created", "written", "flushed", "closed", "published"]) {
			const id = randomUUID(),
				candidate = randomBytes(32);
			if (process.platform === "win32") {
				expect(
					Bun.spawnSync([harness, join(directory, `factor-${id}.key`), stage], { stdin: candidate })
						.exitCode,
				).toBe(75);
				if (stage === "published") expect(await readFactorKey(directory, id)).toEqual(candidate);
				else await expect(readFactorKey(directory, id)).rejects.toBeInstanceOf(KeyViolation);
			} else {
				await expect(
					publishFactorKey(directory, id, candidate, (point) => {
						if (point === stage) throw new Error("Stopped publication.");
					}),
				).rejects.toThrow("Stopped publication");
				if (stage === "before-create" || stage === "created")
					await expect(readFactorKey(directory, id)).rejects.toBeInstanceOf(KeyViolation);
				else expect(await readFactorKey(directory, id)).toEqual(candidate);
			}
			expect(await readFactorKey(directory, active)).toEqual(key);
		}
	} finally {
		await rm(directory, { recursive: true, force: true });
	}
}, 30000);

test("the native key protocol keeps the event loop live and bounds every response", async () => {
	const { runFactorKeyProcess } = await import("./factor-key");
	const run = (source: string, input?: Buffer, timeout?: number) =>
		runFactorKeyProcess([process.execPath, "-e", source], input, timeout);
	let timerRan = false;
	const tick = setTimeout(() => {
		timerRan = true;
	}, 0);
	try {
		const bytes = await run("await Bun.sleep(120); process.stdout.write(Buffer.alloc(32, 7))");
		expect(bytes.equals(Buffer.alloc(32, 7))).toBe(true);
		expect(timerRan).toBe(true);
	} finally {
		clearTimeout(tick);
	}
	await expect(run("process.exit(10)")).rejects.toBeInstanceOf(KeyViolation);
	await expect(run("process.stdout.write(Buffer.alloc(33))")).rejects.toThrow(
		"Key service unavailable",
	);
	await expect(run("process.stdout.write(Buffer.alloc(4096)); process.exit(10)")).rejects.toThrow(
		"Key service unavailable",
	);
	await expect(run("await Bun.sleep(5000)", undefined, 100)).rejects.toThrow(
		"Key service unavailable",
	);
	await expect(run("process.exit(20)")).rejects.toThrow("Key service unavailable");
	await expect(runFactorKeyProcess([join(process.execPath, "unavailable")])).rejects.toThrow(
		"Key service unavailable",
	);
	await expect(run("process.stderr.write('unexpected'); process.exit(10)")).rejects.toThrow(
		"Key service unavailable",
	);
	const key = randomBytes(32);
	const published = await run(
		"if ((await Bun.stdin.bytes()).length !== 32) process.exit(20);",
		key,
	);
	expect(published.length).toBe(0);
	await expect(run("process.stdout.write('x')", key)).rejects.toThrow("Key service unavailable");
});

test.each(["success", "permanent", "temporary"] as const)(
	"a stalled %s key check shares acquisition without holding storage or deciding a new revision",
	async (outcome) => {
		const { openInstallation } = await import("./installation");
		const { checkedSecurity } = await import("./security-state");
		const { createOwnerAccess } = await import("../services/owner/access");
		const { TOTP } = await import("otpauth");
		const directory = await createOwnerDirectory();
		const install = await openInstallation(directory);
		const entered = Promise.withResolvers<void>(),
			release = Promise.withResolvers<void>();
		let reads = 0;
		const stalled = async (dir: string, id: string) => {
			reads++;
			const key = await readFactorKey(dir, id);
			entered.resolve();
			await release.promise;
			if (outcome === "permanent") throw new KeyViolation();
			if (outcome === "temporary") throw new Error("Temporary fixture failure");
			return key;
		};
		try {
			const access = createOwnerAccess(install);
			const password = randomUUID();
			const session = await access.claim(access.rotate(), "owner", password);
			const grant = await access.security.authorize("enable", session, password, "");
			if (grant.kind !== "candidate") throw new Error("Missing enrollment.");
			const enabled = await access.security.activate(
				"enable",
				session,
				grant.proof,
				new TOTP({ secret: grant.manual }).generate(),
			);
			const pending = Promise.allSettled(
				Array.from({ length: 6 }, () => checkedSecurity(install, stalled)),
			);
			await entered.promise;
			const progress = await Promise.race([install.hasOwner(), Bun.sleep(600).then(() => false)]);
			expect(progress).toBe(true);
			// Disable on the live revision while the old lookup is still outstanding.
			await access.security.authorize("disable", enabled.session, password, enabled.codes[0]);
			expect((await checkedSecurity(install)).factor).toBeNull();
			release.resolve();
			expect(reads).toBe(1);
			for (const result of await pending) {
				expect(result.status).toBe("rejected");
				if (result.status === "rejected")
					expect(result.reason.message).toContain("Authorization expired");
			}
			expect((await checkedSecurity(install)).state.recovery_required).toBe(0);
		} finally {
			release.resolve();
			await install.close();
			await rm(directory, { recursive: true, force: true });
		}
	},
	30000,
);

test("a native publication refusal remains authoritative when the input pipe closes first", async () => {
	const { runFactorKeyProcess } = await import("./factor-key");
	const key = randomBytes(32),
		end = Writable.prototype.end;
	// Deliver the Windows pipe event before the real child exits, irrespective of OS pipe buffering.
	const pipe = spyOn(Writable.prototype, "end").mockImplementation(function (
		this: Writable,
		...args: unknown[]
	) {
		if (args[0] === key)
			this.emit("error", Object.assign(new Error("Fixture pipe closed"), { code: "EPIPE" }));
		return Reflect.apply(end, this, args);
	});
	try {
		const run = (code: number) =>
			runFactorKeyProcess([process.execPath, "-e", `process.exit(${code})`], key);
		await expect(run(10)).rejects.toBeInstanceOf(KeyViolation);
		await expect(run(20)).rejects.toThrow("Key service unavailable");
		await expect(run(0)).rejects.toThrow("Key service unavailable");
	} finally {
		pipe.mockRestore();
	}
});

test.skipIf(process.platform !== "win32")(
	"a loose parent ACL refuses native publication before the helper reads the key",
	async () => {
		const directory = await createOwnerDirectory();
		try {
			expect(Bun.spawnSync(["icacls.exe", directory, "/grant", "*S-1-5-32-545:R"]).exitCode).toBe(
				0,
			);
			await expect(
				publishFactorKey(directory, randomUUID(), randomBytes(32)),
			).rejects.toBeInstanceOf(KeyViolation);
		} finally {
			await rm(directory, { recursive: true, force: true });
		}
	},
);
