import { expect, test } from "bun:test";
import { chmod, copyFile, exists, readdir, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { sql } from "drizzle-orm";
import { TOTP } from "otpauth";
import { openInstallation } from "../src/lib/server/db/installation";
import { providerStore } from "../src/lib/server/db/provider-store";
import { lockFilename } from "../src/lib/server/db/recovery-lock";
import { checkedSecurity } from "../src/lib/server/db/security-state";
import { unsupportedPlatformMessage } from "../src/lib/server/platform";
import { galleryStorage } from "../src/lib/server/services/gallery/storage";
import { createOwnerAccess } from "../src/lib/server/services/owner/access";
import { createOwnerDirectory } from "../tests/fixtures/owner-directory";
import { referencePng } from "../tests/fixtures/reference-image";

function command(directory: string) {
	let output = "";
	const prompts = ["New password:", "Confirm password:", "Access restored."].map(() =>
		Promise.withResolvers<void>(),
	);
	const term = new Bun.Terminal({
		cols: 180,
		rows: 30,
		data(_term, bytes) {
			output += Buffer.from(bytes).toString();
			for (const [index, label] of [
				"New password:",
				"Confirm password:",
				"Access restored.",
			].entries())
				if (output.includes(label)) prompts[index].resolve();
		},
	});
	const prior = term.localFlags;
	const child = Bun.spawn([process.execPath, "run", "owner:recover"], {
		terminal: term,
		env: { ...process.env, SILUET_DATA_DIR: directory },
	});
	const wait = async (i: number) => {
		await Promise.race([
			prompts[i].promise,
			child.exited.then(() => {
				if (!output.includes(["New password:", "Confirm password:", "Access restored."][i]))
					throw new Error("Expected interactive recovery prompt.");
			}),
		]);
	};
	return { child, term, wait, output: () => output, prior };
}
test("recovery requires an interactive terminal before inspecting storage", async () => {
	const directory = await createOwnerDirectory();
	try {
		const child = Bun.spawnSync([process.execPath, "run", "owner:recover"], {
			stdin: Buffer.from("unused"),
			env: { ...process.env, SILUET_DATA_DIR: directory },
		});
		expect(child.exitCode).toBe(1);
		expect(child.stderr.toString()).toContain("interactive terminal");
		expect(await readdir(directory)).toEqual([]);
	} finally {
		await rm(directory, { recursive: true, force: true });
	}
});
test("recovery on a foreign platform refuses before storage", async () => {
	const parent = await createOwnerDirectory();
	try {
		const directory = join(parent, "siluet");
		const child = Bun.spawnSync(
			[
				process.execPath,
				"--preload",
				join(import.meta.dir, "../tests/fixtures/foreign-platform.ts"),
				join(import.meta.dir, "owner-recover.ts"),
			],
			{ env: { ...process.env, SILUET_DATA_DIR: directory, SILUET_TEST_PLATFORM: "freebsd" } },
		);
		expect(child.stderr.toString()).toBe(`${unsupportedPlatformMessage}\n`);
		expect(child.exitCode).toBe(1);
		expect(await exists(directory)).toBe(false);
	} finally {
		await rm(parent, { recursive: true, force: true });
	}
});
test.each(["missing", "unsafe"])(
	"recover a claimed studio with a %s active key through its native terminal",
	async (damage) => {
		const source = await createOwnerDirectory();
		let directory = source;
		let install = await openInstallation(directory);
		let active = true;
		try {
			const original = crypto.randomUUID(),
				password = crypto.randomUUID();
			const access = createOwnerAccess(install),
				session = await access.claim(access.rotate(), "owner", original);
			const grant = await access.security.authorize("enable", session, original, "");
			if (grant.kind !== "candidate") throw new Error("Expected candidate.");
			const issued = await access.security.activate(
				"enable",
				session,
				grant.proof,
				new TOTP({ secret: grant.manual }).generate(),
			);
			const proof = await access.signIn("owner", original);
			const provider = providerStore(install);
			await provider.save("poyo", "fixture-only", 10, true, await provider.revision("poyo"));
			await install.use(async (db) => {
				await db.run(
					sql`INSERT INTO image_job (id,binding,provider,revision,quote,state,model,created_at,poll_deadline,submission_recorded_at,task_id) VALUES ('saved-job','saved-binding','poyo',1,'{}','completed','seedream-5.5',1,120002,2,'fixture-task')`,
				);
				await db.run(sql`UPDATE factor_budget SET failures=100`);
				for (let i = 0; i < 10; i++)
					await db.run(
						sql`INSERT INTO auth_attempt VALUES(${crypto.randomUUID()},'signin',${Date.now()})`,
					);
			});
			await galleryStorage(install).publish("saved-job", Buffer.from(referencePng), {
				mime: "image/png",
				width: 1,
				height: 1,
			});
			const id = install.id;
			const key = (await readdir(directory)).find((n) => /^factor-.*\.key$/.test(n));
			if (!key) throw new Error("Expected key.");
			const path = join(directory, key);
			await install.close();
			active = false;
			if (damage === "missing") {
				// Restore the stopped studio from files that survived the loss of the published key.
				directory = await createOwnerDirectory();
				for (const name of await readdir(source)) {
					if (name !== key) await copyFile(join(source, name), join(directory, name));
				}
			} else await chmod(path, 0o644);
			install = await openInstallation(directory);
			active = true;
			await expect(checkedSecurity(install)).rejects.toThrow("owner:recover");
			const busy = command(directory);
			try {
				expect(await busy.child.exited).toBe(1);
				expect(busy.output()).not.toContain("New password:");
			} finally {
				busy.term.close();
			}
			await install.close();
			active = false;
			const sentinel = await readFile(join(directory, lockFilename));
			const cancelled = command(directory);
			try {
				await cancelled.wait(0);
				await expect(openInstallation(directory)).rejects.toThrow();
				cancelled.term.write("\x03");
				expect(await cancelled.child.exited).toBe(1);
				expect(cancelled.term.localFlags).toBe(cancelled.prior);
			} finally {
				cancelled.child.kill();
				cancelled.term.close();
			}
			const recovery = command(directory);
			try {
				await recovery.wait(0);
				recovery.term.write(`${password}\r`);
				await recovery.wait(1);
				recovery.term.write(`${password}\r`);
				expect(await recovery.child.exited).toBe(0);
				expect(recovery.output()).not.toContain(password);
				expect(recovery.term.localFlags).toBe(recovery.prior);
			} finally {
				recovery.child.kill();
				recovery.term.close();
			}
			expect(await readFile(join(directory, lockFilename))).toEqual(sentinel);
			install = await openInstallation(directory);
			active = true;
			expect(install.id).toBe(id);
			const recovered = createOwnerAccess(install);
			expect(await recovered.session(issued.session)).toBeNull();
			await expect(recovered.security.complete(proof.token, issued.codes[0])).rejects.toThrow();
			await expect(recovered.signIn("owner", original)).rejects.toThrow();
			expect((await recovered.signIn("owner", password)).kind).toBe("session");
			expect((await providerStore(install).credential("poyo"))?.key).toBe("fixture-only");
			expect(
				await install.use((db) =>
					db.get(sql`SELECT job_id FROM gallery_image WHERE job_id='saved-job'`),
				),
			).toEqual({ job_id: "saved-job" });
			expect((await galleryStorage(install).read("saved-job"))?.bytes).toEqual(
				Buffer.from(referencePng),
			);
			expect((await readdir(directory)).includes(key)).toBe(damage === "unsafe");
		} finally {
			if (active) await install.close();
			await rm(directory, { recursive: true, force: true });
			if (directory !== source) await rm(source, { recursive: true, force: true });
		}
	},
	60000,
);
