import { expect, test } from "bun:test";
import { randomBytes, randomUUID } from "node:crypto";
import { chmod, link, rm, unlink } from "node:fs/promises";
import { join } from "node:path";
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
		await chmod(path, 0o644);
		await expect(readFactorKey(dir, id)).rejects.toBeInstanceOf(KeyViolation);
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
		for (const stage of ["before-create", "created", "written", "flushed", "closed", "published"]) {
			const id = randomUUID(),
				candidate = randomBytes(32);
			await expect(
				publishFactorKey(directory, id, candidate, (point) => {
					if (point === stage) throw new Error("Stopped publication.");
				}),
			).rejects.toThrow("Stopped publication");
			if (stage === "before-create" || stage === "created")
				await expect(readFactorKey(directory, id)).rejects.toBeInstanceOf(KeyViolation);
			else expect(await readFactorKey(directory, id)).toEqual(candidate);
			expect(await readFactorKey(directory, active)).toEqual(key);
		}
	} finally {
		await rm(directory, { recursive: true, force: true });
	}
}, 30000);

test.each(["success", "permanent", "temporary"] as const)(
	"a stalled %s key check shares acquisition without holding storage or deciding a new revision",
	async (outcome) => {
		const { openInstallation } = await import("./installation");
		const { checkedSecurity, checkRequestSecurity } = await import("./security-state");
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
			const request = Promise.allSettled([checkRequestSecurity(install, stalled)]);
			await entered.promise;
			const progress = await Promise.race([install.hasOwner(), Bun.sleep(600).then(() => false)]);
			expect(progress).toBe(true);
			// Disable on the live revision while the old lookup is still outstanding.
			await access.security.authorize("disable", enabled.session, password, enabled.codes[0]);
			expect((await checkedSecurity(install)).factor).toBeNull();
			release.resolve();
			expect(await request).toMatchObject([{ status: "fulfilled" }]);
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

test("a loose parent refuses publication and reading", async () => {
	const directory = await createOwnerDirectory();
	const id = randomUUID();
	try {
		await publishFactorKey(directory, id, randomBytes(32));
		await chmod(directory, 0o755);
		await expect(publishFactorKey(directory, randomUUID(), randomBytes(32))).rejects.toBeInstanceOf(
			KeyViolation,
		);
		await expect(readFactorKey(directory, id)).rejects.toBeInstanceOf(KeyViolation);
	} finally {
		await chmod(directory, 0o700);
		await rm(directory, { recursive: true, force: true });
	}
});
