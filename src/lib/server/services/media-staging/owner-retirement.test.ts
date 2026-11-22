import { afterEach, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { readdir, rm } from "node:fs/promises";
import { sql } from "drizzle-orm";
import { TOTP } from "otpauth";
import { createOwnerDirectory } from "../../../../../tests/fixtures/owner-directory";
import { idleMs } from "../../db/access-store";
import { KeyViolation } from "../../db/factor-key";
import { type Installation, openInstallation } from "../../db/installation";
import { recoverOwner } from "../../db/recover-owner";
import { openRuntimeInstallation } from "../../db/runtime-installation";
import { checkRequestSecurity } from "../../db/security-state";
import { createOwnerAccess } from "../owner/access";
import { hashPassword, sessionDigest } from "../owner/credentials";
import { createScratchPool } from "./scratch";
import { createStages } from "./stages";

const bytes = new Uint8Array([1, 2, 3]);
const media = {
	bytes,
	digest: createHash("sha256").update(bytes).digest("hex"),
	size: bytes.length,
	mime: "image/png" as const,
	transform: "none" as const,
};

const cleanup: (() => Promise<void>)[] = [];
afterEach(async () => {
	for (const step of cleanup.splice(0).reverse()) await step();
});

async function studio(now = Date.now) {
	const root = await createOwnerDirectory();
	cleanup.push(() => rm(root, { recursive: true, force: true }));
	const installation = await openRuntimeInstallation(root);
	cleanup.push(() => installation.close());
	const pool = createScratchPool(installation);
	await pool.reclaim();
	const scratch = await pool.scope("image");
	const stages = createStages(scratch);
	cleanup.push(() => stages.close());
	const ownerInstallation = { ...installation, retireSessions: stages.retireSessions };
	const access = createOwnerAccess(ownerInstallation, now);
	const password = crypto.randomUUID();
	const raw = await access.claim(access.rotate(), "owner", password);
	async function stage(token: string) {
		const scope = { owner: "owner", session: sessionDigest(token), draft: crypto.randomUUID() };
		const descriptor = await stages.put(scope, media);
		const preview = await stages.openPreview(scope, descriptor.handle);
		if (!preview) throw new Error("Missing staged preview");
		return { scope, descriptor, preview };
	}
	return { root, installation, ownerInstallation, stages, scratch, access, password, raw, stage };
}

async function settled(directory: string) {
	for (let i = 0; i < 50 && (await readdir(directory)).length; i++) await Bun.sleep(10);
	return readdir(directory);
}

test("rotateSecurity retires open previews and tentative claims, retaining committed transfers", async () => {
	const { installation, stages, access, password, raw, stage } = await studio();
	const old = await stage(raw);
	const winner = await stage(raw);
	const held = await stages.claim(winner.scope, winner.descriptor, (_valid, durable) =>
		durable(async () => true),
	);
	const ready = Promise.withResolvers<void>();
	const resume = Promise.withResolvers<void>();
	cleanup.push(async () => resume.resolve());
	const tentative = stages.claim(old.scope, old.descriptor, async (_valid, durable) => {
		ready.resolve();
		await resume.promise;
		return durable(async () => true);
	});
	await ready.promise;
	const grant = await access.security.authorize("enable", raw, password, "");
	if (!("manual" in grant)) throw new Error("Missing authenticator candidate");
	const step = new TOTP({ secret: grant.manual }).generate();
	await installation.use((db) =>
		db.run(
			sql`CREATE TRIGGER refuse_stage_rotation BEFORE INSERT ON session BEGIN SELECT RAISE(ABORT,'fixture rollback'); END`,
		),
	);
	// A rolled-back rotation retires nothing.
	await expect(access.security.activate("enable", raw, grant.proof, step)).rejects.toThrow();
	expect(old.preview.signal.aborted).toBeFalse();
	await installation.use((db) => db.run(sql`DROP TRIGGER refuse_stage_rotation`));
	const rotated = await access.security.activate("enable", raw, grant.proof, step);
	expect(old.preview.signal.aborted).toBeTrue();
	resume.resolve();
	expect(await tentative).toBeNull();
	expect(held?.bytes).toEqual(media.bytes);
	held?.release();
	const next = await stage(rotated.session);
	expect(next.preview.signal.aborted).toBeFalse();
	await installation.use((db) => db.run(sql`DELETE FROM recovery_code`));
	await expect(access.security.snapshot()).rejects.toThrow();
	expect(next.preview.signal.aborted).toBeTrue();
	expect(await stages.preview(next.scope, next.descriptor.handle)).toBeNull();
}, 30_000);

test("checkRequestSecurity(ownerInstallation), including its 403 retry, aborts open previews", async () => {
	const { installation, ownerInstallation, scratch, access, password, raw, stage } = await studio();
	const grant = await access.security.authorize("enable", raw, password, "");
	if (!("manual" in grant)) throw new Error("Missing authenticator candidate");
	const step = new TOTP({ secret: grant.manual }).generate();
	const { session } = await access.security.activate("enable", raw, grant.proof, step);
	const open = await stage(session);
	let reads = 0;
	// The first read races a policy change (403). The retry finds a damaged key.
	const readKey = async () => {
		if (++reads === 1) {
			await installation.use((db) => db.run(sql`UPDATE owner_security SET revision=revision+1`));
			return Buffer.alloc(32);
		}
		throw new KeyViolation();
	};
	await expect(checkRequestSecurity(ownerInstallation, readKey)).rejects.toThrow();
	expect(reads).toBe(2);
	expect(open.preview.signal.aborted).toBeTrue();
	expect(await settled(scratch.directory)).toEqual([]);
	expect(await access.session(session)).toBeNull();
}, 30_000);

test("sign-out and idle expiry retire only affected sessions, including while a stage is being validated", async () => {
	const time = Date.now();
	const { installation, stages, access, password, raw, stage } = await studio(() => time);
	const second = await access.signIn("owner", password);
	const third = await access.signIn("owner", password);
	if (second.kind !== "session" || third.kind !== "session") throw new Error("Missing sessions");
	const active = await stage(second.token);
	const expired = await stage(third.token);
	const leaving = await stage(raw);
	expect(await access.signOut(raw)).toBeTrue();
	expect(leaving.preview.signal.aborted).toBeTrue();
	expect(active.preview.signal.aborted).toBeFalse();
	await installation.use((db) =>
		db.run(
			sql`UPDATE session SET created_at=${time - idleMs},last_activity=${time - idleMs} WHERE digest=${expired.scope.session}`,
		),
	);
	await expect(
		stages.put(expired.scope, media, async () => !!(await access.session(third.token))),
	).rejects.toThrow();
	expect(expired.preview.signal.aborted).toBeTrue();
	expect(active.preview.signal.aborted).toBeFalse();
	expect(await active.preview.handle.read(new Uint8Array(3), 0, 3, 0)).toMatchObject({
		bytesRead: 3,
	});
});

test("recoverOwner retires every staged session it removes", async () => {
	const root = await createOwnerDirectory();
	cleanup.push(() => rm(root, { recursive: true, force: true }));
	const claimed = await openInstallation(root);
	const access = createOwnerAccess(claimed);
	const token = await access.claim(access.rotate(), "owner", crypto.randomUUID());
	await claimed.close();
	const retired: string[] = [];
	const recovery: Installation = {
		...(await openInstallation(root, "recovery")),
		retireSessions: (digests) => retired.push(...digests),
	};
	try {
		await recoverOwner(recovery, await hashPassword(crypto.randomUUID()), () => {});
	} finally {
		await recovery.close();
	}
	expect(retired).toEqual([sessionDigest(token)]);
});
