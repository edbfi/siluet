import { afterEach, beforeEach, expect, spyOn, test } from "bun:test";
import {
	chmod,
	link,
	lstat,
	open,
	readdir,
	readFile,
	rm,
	symlink,
	unlink,
	writeFile,
} from "node:fs/promises";
import { join } from "node:path";
import { connect } from "@tursodatabase/database";
import { sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/tursodatabase/database";
import { createOwnerDirectory } from "../../../../tests/fixtures/owner-directory";
import { createProviderConnections } from "../services/providers/connections";
import { type Installation, openInstallation } from "./installation";
import { migrateInstallation, ownerMigrations } from "./migrations";
import { providerKeyFilename, readProviderKey } from "./provider-key";
import { providerStore } from "./provider-store";

let directory: string;
let installation: Installation;

beforeEach(async () => {
	directory = await createOwnerDirectory();
	installation = await openInstallation(directory);
});
afterEach(async () => {
	await installation.close();
	await rm(directory, { recursive: true, force: true });
});

const keyPath = () => join(directory, providerKeyFilename);
const poyoKey = "fixture-poyo-credential";
const toapisKey = "fixture-toapis-credential";

async function statusOf(store: ReturnType<typeof providerStore>, id: "poyo" | "toapis") {
	return (await store.statuses()).find((status) => status.id === id);
}

async function saveCurrent(
	store: ReturnType<typeof providerStore>,
	id: "poyo" | "toapis",
	key: string,
	time: number,
	access: boolean,
) {
	expect(await store.save(id, key, time, access, await store.revision(id))).toBe(true);
}

test("provider verification metadata survives restart alongside encrypted credentials", async () => {
	const store = providerStore(installation);
	expect(await statusOf(store, "poyo")).toEqual({ id: "poyo", state: "disconnected" });
	await expect(lstat(keyPath())).rejects.toMatchObject({ code: "ENOENT" });
	await saveCurrent(store, "poyo", poyoKey, 123, true);
	await saveCurrent(store, "toapis", toapisKey, 456, false);
	await installation.close();
	const database = await readFile(join(directory, "studio.db"));
	expect(database.includes(poyoKey)).toBe(false);
	expect(database.includes(toapisKey)).toBe(false);
	installation = await openInstallation(directory);
	const reopened = providerStore(installation);
	expect(await statusOf(reopened, "poyo")).toEqual({
		id: "poyo",
		state: "connected",
		verifiedAt: 123,
		seedream: true,
	});
	expect(await statusOf(reopened, "toapis")).toEqual({
		id: "toapis",
		state: "connected",
		verifiedAt: 456,
		seedream: false,
	});
	await reopened.remove("poyo");
	expect(await statusOf(reopened, "poyo")).toEqual({ id: "poyo", state: "disconnected" });
	expect(await statusOf(reopened, "toapis")).toEqual({
		id: "toapis",
		state: "connected",
		verifiedAt: 456,
		seedream: false,
	});
});

test("readable Seedream revisions follow ciphertext and key changes between Jobs loads", async () => {
	const store = providerStore(installation);
	await saveCurrent(store, "poyo", poyoKey, 123, true);
	await saveCurrent(store, "toapis", toapisKey, 456, false);
	const poyo = { provider: "poyo", model: "seedream-5.5", revision: 1 } as const;
	const toapis = { provider: "toapis", model: "doubao-seedream-5-5", revision: 1 } as const;
	let readable = await store.jobReadability();
	expect(readable(poyo)).toBe(true);
	expect(readable(toapis)).toBe(false);
	await saveCurrent(store, "poyo", poyoKey, 124, true);
	readable = await store.jobReadability();
	expect(readable(poyo)).toBe(false);
	expect(readable({ ...poyo, revision: 2 })).toBe(true);
	await installation.use((db) =>
		db.run(sql`UPDATE provider_credential SET ciphertext='corrupt' WHERE provider='poyo'`),
	);
	expect((await store.jobReadability())({ ...poyo, revision: 2 })).toBe(false);
	await saveCurrent(store, "toapis", toapisKey, 457, true);
	expect((await store.jobReadability())({ ...toapis, revision: 2 })).toBe(true);
	await writeFile(keyPath(), Buffer.alloc(32, 42));
	expect((await store.jobReadability())({ ...toapis, revision: 2 })).toBe(false);
});

test.each(["missing", "malformed", "unmatched"])(
	"a missing, malformed, or unmatched key (%s) requires reconnect without erasing verification metadata",
	async (failure) => {
		let store = providerStore(installation);
		await saveCurrent(store, "poyo", poyoKey, 123, true);
		await saveCurrent(store, "toapis", toapisKey, 456, false);
		switch (failure) {
			case "missing":
				await unlink(keyPath());
				break;
			case "malformed":
				await writeFile(keyPath(), "corrupt fixture");
				break;
			case "unmatched":
				await writeFile(keyPath(), crypto.getRandomValues(new Uint8Array(32)));
				break;
		}
		await installation.close();
		installation = await openInstallation(directory);
		store = providerStore(installation);
		expect(await statusOf(store, "poyo")).toEqual({ id: "poyo", state: "reconnect" });
		expect(
			await installation.use((db) =>
				db.get(sql`SELECT verified_at, seedream FROM provider_credential WHERE provider='poyo'`),
			),
		).toEqual({ verified_at: 123, seedream: 1 });
		await saveCurrent(store, "poyo", poyoKey, 789, true);
		expect(await statusOf(store, "poyo")).toEqual({
			id: "poyo",
			state: "connected",
			verifiedAt: 789,
			seedream: true,
		});
		expect(await statusOf(store, "toapis")).toEqual({ id: "toapis", state: "reconnect" });
	},
);

test("ciphertext cannot be transferred to a different provider", async () => {
	const store = providerStore(installation);
	await saveCurrent(store, "poyo", poyoKey, 123, true);
	await saveCurrent(store, "toapis", toapisKey, 123, true);
	await installation.use((db) =>
		db.run(
			sql`UPDATE provider_credential SET ciphertext=(SELECT ciphertext FROM provider_credential WHERE provider='poyo') WHERE provider='toapis'`,
		),
	);
	expect(await statusOf(store, "toapis")).toEqual({ id: "toapis", state: "reconnect" });
	expect(await statusOf(store, "poyo")).toEqual({
		id: "poyo",
		state: "connected",
		verifiedAt: 123,
		seedream: true,
	});
});

test("the separate key must be a regular owner-only file", async () => {
	const store = providerStore(installation);
	await saveCurrent(store, "poyo", poyoKey, 123, true);
	expect((await lstat(keyPath())).mode & 0o777).toBe(0o600);
	await chmod(keyPath(), 0o640);
	expect(await statusOf(store, "poyo")).toEqual({
		id: "poyo",
		state: "repair",
		hasCredential: true,
	});
	await expect(saveCurrent(store, "poyo", poyoKey, 789, false)).rejects.toThrow();
	await chmod(keyPath(), 0o600);
	expect(await statusOf(store, "poyo")).toEqual({
		id: "poyo",
		state: "connected",
		verifiedAt: 123,
		seedream: true,
	});
	const alias = join(directory, "alias");
	await link(keyPath(), alias);
	expect(await statusOf(store, "poyo")).toEqual({
		id: "poyo",
		state: "repair",
		hasCredential: true,
	});
	await unlink(alias);
	await writeFile(alias, await readFile(keyPath()), { mode: 0o600 });
	await unlink(keyPath());
	await symlink(alias, keyPath());
	expect(await statusOf(store, "poyo")).toEqual({
		id: "poyo",
		state: "repair",
		hasCredential: true,
	});
	await expect(saveCurrent(store, "poyo", poyoKey, 789, false)).rejects.toThrow();
	expect((await lstat(keyPath())).isSymbolicLink()).toBe(true);
});

test("reading key status does not create a missing installation directory", async () => {
	const missing = join(directory, "absent");
	await expect(readProviderKey(missing)).rejects.toThrow("private directory");
	await expect(lstat(missing)).rejects.toMatchObject({ code: "ENOENT" });
});

test("an unsafe key at startup requires repair without closing", async () => {
	await saveCurrent(providerStore(installation), "poyo", poyoKey, 123, true);
	await installation.close();
	await chmod(keyPath(), 0o640);
	installation = await openInstallation(directory);
	const store = providerStore(installation);
	expect(await statusOf(store, "poyo")).toEqual({
		id: "poyo",
		state: "repair",
		hasCredential: true,
	});
	expect(await installation.hasOwner()).toBe(false);
	await expect(saveCurrent(store, "poyo", poyoKey, 789, false)).rejects.toThrow();
});

test("a failed directory sync leaves the credential unpublished", async () => {
	const store = providerStore(installation);
	const revision = await store.revision("poyo");
	const probe = await open(directory, "r");
	const proto = Object.getPrototypeOf(probe);
	await probe.close();
	const syncFile = proto.sync;
	const sync = spyOn(proto, "sync").mockImplementation(async function (this: typeof probe) {
		if ((await this.stat()).isDirectory())
			throw Object.assign(new Error("Fixture directory sync failed"), { code: "EIO" });
		return syncFile.apply(this);
	});
	try {
		await expect(store.save("poyo", poyoKey, 123, true, revision)).rejects.toThrow();
	} finally {
		sync.mockRestore();
	}
	expect(await statusOf(store, "poyo")).toEqual({ id: "poyo", state: "disconnected" });
	expect(await store.revision("poyo")).toBe(revision);
});

test("an owner-only installation upgrades in place and revokes its cookie session", async () => {
	await installation.close();
	await rm(directory, { recursive: true, force: true });
	directory = await createOwnerDirectory();
	const id = crypto.randomUUID();
	await writeFile(join(directory, "installation.id"), id, { mode: 0o600 });
	const client = await connect(join(directory, "studio.db"));
	try {
		const db = drizzle({ client });
		await migrateInstallation(db, true, ownerMigrations);
		await db.run(sql`INSERT INTO installation VALUES (1, ${id}, 1)`);
		await db.run(sql`INSERT INTO owner VALUES (1, 'owner', 'existing-hash', 42)`);
		await db.run(sql`INSERT INTO session VALUES ('fixture-digest', 1, 42, 42)`);
	} finally {
		await client.close();
	}
	installation = await openInstallation(directory);
	expect(installation.id).toBe(id);
	expect(await installation.hasOwner()).toBe(true);
	// A cookie session may have reached another port, so the browser-key upgrade revokes it.
	expect(await installation.use((db) => db.all(sql`SELECT digest FROM session`))).toEqual([]);
	expect(await statusOf(providerStore(installation), "poyo")).toEqual({
		id: "poyo",
		state: "disconnected",
	});
	await expect(lstat(keyPath())).rejects.toMatchObject({ code: "ENOENT" });
});

test("an independent writer supersedes a check that started against an older provider revision", async () => {
	const secondInstallation = await openInstallation(directory);
	try {
		const delayed = providerStore(installation);
		const current = providerStore(secondInstallation);

		const disconnected = await delayed.revision("poyo");
		await current.remove("poyo");
		expect(await delayed.save("poyo", poyoKey, 123, true, disconnected)).toBe(false);
		expect(await statusOf(current, "poyo")).toEqual({ id: "poyo", state: "disconnected" });

		const beforeReplacement = await delayed.revision("poyo");
		await current.save("poyo", poyoKey, 456, true, beforeReplacement);
		await current.save("toapis", toapisKey, 789, false, await current.revision("toapis"));
		expect(await delayed.save("poyo", "fixture-older-key", 123, false, beforeReplacement)).toBe(
			false,
		);
		expect(await statusOf(delayed, "poyo")).toEqual({
			id: "poyo",
			state: "connected",
			verifiedAt: 456,
			seedream: true,
		});
		expect(await statusOf(delayed, "toapis")).toEqual({
			id: "toapis",
			state: "connected",
			verifiedAt: 789,
			seedream: false,
		});
	} finally {
		await secondInstallation.close();
	}
});

// Bounded wait is provided by the pinned Turso driver’s connect timeout option.
// https://github.com/tursodatabase/turso/blob/main/docs/javascript-api-reference.md
test("independent installations save simultaneous provider checks with a single read each", async () => {
	const second = await openInstallation(directory);
	const started = Promise.withResolvers<void>();
	let reads = 0;
	const check = async () => {
		if (++reads === 2) started.resolve();
		await started.promise;
		return { outcome: "accepted", seedream: true } as const;
	};
	try {
		const checks = { poyo: check, toapis: check };
		const firstService = createProviderConnections(providerStore(installation), checks);
		const secondService = createProviderConnections(providerStore(second), checks);
		expect(
			await Promise.all([
				firstService.connect("poyo", poyoKey),
				secondService.connect("toapis", toapisKey),
			]),
		).toEqual(["connected", "connected"]);
		expect(reads).toBe(2);
		expect((await firstService.imageAvailability()).eligibleProviders).toEqual(["poyo", "toapis"]);
		expect((await readdir(directory)).filter((name) => name.endsWith(".tmp"))).toEqual([]);
	} finally {
		await second.close();
	}
});

test("removal survives a brief write lock held by another installation", async () => {
	const other = await openInstallation(directory);
	const store = providerStore(other);
	let removal: ReturnType<typeof store.remove> | undefined;
	try {
		await saveCurrent(store, "poyo", poyoKey, 123, true);
		const revision = await store.revision("poyo");
		await installation.use((db) =>
			db.transaction(
				async () => {
					removal = store.remove("poyo");
					void removal.catch(() => {});
					await Bun.sleep(100);
				},
				{ behavior: "immediate" },
			),
		);
		await removal;
		expect(await store.revision("poyo")).toBe(revision + 1);
		expect(await statusOf(store, "poyo")).toEqual({ id: "poyo", state: "disconnected" });
	} finally {
		await other.close();
	}
});

test("a continuing write lock leaves the saved connection intact", async () => {
	const other = await openInstallation(directory);
	try {
		const store = providerStore(other);
		await saveCurrent(store, "poyo", poyoKey, 123, true);
		const revision = await store.revision("poyo");
		await installation.use((db) =>
			db.transaction(
				async () => {
					// Removal takes the write lock first, so it starts nothing while another holds it.
					await expect(store.remove("poyo")).rejects.toThrow("database is locked");
				},
				{ behavior: "immediate" },
			),
		);
		expect(await store.revision("poyo")).toBe(revision);
		expect(await statusOf(store, "poyo")).toEqual({
			id: "poyo",
			state: "connected",
			verifiedAt: 123,
			seedream: true,
		});
	} finally {
		await other.close();
	}
});

test("unsafe key permissions require repair before sending a candidate to a provider", async () => {
	let reads = 0;
	const check = async () => {
		reads++;
		return { outcome: "accepted", seedream: true } as const;
	};
	const store = providerStore(installation);
	const service = createProviderConnections(store, { poyo: check, toapis: check });
	await saveCurrent(store, "poyo", poyoKey, 123, true);
	await chmod(keyPath(), 0o640);
	try {
		expect(await service.statuses()).toEqual([
			{ id: "poyo", state: "repair", hasCredential: true },
			{ id: "toapis", state: "repair", hasCredential: false },
		]);
		expect(await service.connect("poyo", poyoKey)).toBe("storage-repair");
		expect(await service.connect("toapis", toapisKey)).toBe("storage-repair");
		expect(reads).toBe(0);
	} finally {
		await chmod(keyPath(), 0o600);
	}
	expect((await service.imageAvailability()).eligibleProviders).toEqual(["poyo"]);
	expect(await service.connect("toapis", toapisKey)).toBe("connected");
	expect(reads).toBe(1);
});

test("dispatch opens an eligible credential only at the requested revision", async () => {
	const store = providerStore(installation);
	await saveCurrent(store, "poyo", poyoKey, 123, true);
	expect(await store.credential("poyo", 1)).toEqual({ revision: 1, key: poyoKey });
	expect(await store.credential("poyo", 2)).toBeNull();
	await saveCurrent(store, "poyo", toapisKey, 125, false);
	expect(await store.credential("poyo")).toBeNull();
	await store.remove("poyo");
	expect(await store.credential("poyo", 1)).toBeNull();
});

test("Poyo balance access follows the readable revision independently of Seedream permission", async () => {
	const store = providerStore(installation);
	await saveCurrent(store, "poyo", poyoKey, 123, false);
	await saveCurrent(store, "toapis", toapisKey, 123, true);
	expect(await store.credential("poyo", 1, "poyo-balance")).toEqual({ revision: 1, key: poyoKey });
	expect(await store.credential("toapis", 1, "poyo-balance")).toBeNull();
	expect(await store.credential("poyo", 1)).toBeNull();
	const readable = await store.jobReadability();
	expect(readable({ provider: "poyo", model: "z-image", revision: 1 })).toBe(true);
	expect(readable({ provider: "poyo", model: "seedream-5.5", revision: 1 })).toBe(false);
	expect(readable({ provider: "toapis", model: "doubao-seedream-5-5", revision: 1 })).toBe(true);
	await saveCurrent(store, "poyo", "another-fixture-key", 124, true);
	expect(await store.credential("poyo", 1, "poyo-balance")).toBeNull();
	expect(await store.credential("poyo", 2, "poyo-balance")).toMatchObject({ revision: 2 });
	await store.remove("poyo");
	expect(await store.credential("poyo", 2, "poyo-balance")).toBeNull();
});

test("ToAPIs image access opens any readable ToAPIs key and never a Poyo.ai one", async () => {
	const store = providerStore(installation);
	await saveCurrent(store, "poyo", poyoKey, 123, true);
	await saveCurrent(store, "toapis", toapisKey, 123, false);
	expect(await store.credential("toapis", 1, "toapis-image")).toEqual({
		revision: 1,
		key: toapisKey,
	});
	expect(await store.credential("toapis", 2, "toapis-image")).toBeNull();
	expect(await store.credential("poyo", 1, "toapis-image")).toBeNull();
	expect(await store.credential("toapis", 1)).toBeNull();
	await store.remove("toapis");
	expect(await store.credential("toapis", 1, "toapis-image")).toBeNull();
});

test("a key swapped for a FIFO after its checks is refused without blocking", async () => {
	const child = Bun.spawnSync(
		[
			process.execPath,
			join(import.meta.dir, "../../../../tests/fixtures/fifo-key-swap.ts"),
			directory,
		],
		{ timeout: 10_000 },
	);
	expect(child.stdout.toString().trim()).toBe("ProviderKeyPolicyError");
});
