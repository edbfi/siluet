import { afterEach, expect, test } from "bun:test";
import { rm } from "node:fs/promises";
import { sql } from "drizzle-orm";
import { createOwnerDirectory } from "../../../../../tests/fixtures/owner-directory";
import { accessStore } from "../../db/access-store";
import { type Installation, openInstallation } from "../../db/installation";
import { deleteOwnerSessions, ownerTransaction } from "../../db/session-retirement";
import { createOwnerAccess } from "./access";
import { bearerMs, createBearers } from "./bearers";

const cleanup: (() => Promise<unknown>)[] = [];
afterEach(async () => {
	for (const step of cleanup.splice(0).reverse()) await step();
});

test("a bearer lasts ten minutes on the monotonic clock", () => {
	let now = 0;
	const bearers = createBearers(() => now);
	const bearer = bearers.issue("session-a");
	expect(bearer).toMatch(/^[\w-]{43}$/);
	now += bearerMs - 1;
	expect(bearers.session(bearer)).toBe("session-a");
	now += 1;
	expect(bearers.session(bearer)).toBeNull();
	expect(bearers.session("not a bearer")).toBeNull();
	expect(bearers.session(null)).toBeNull();
});

test("a session keeps its newest 64 bearers", () => {
	const bearers = createBearers(() => 0);
	const issued = Array.from({ length: 65 }, () => bearers.issue("session-a"));
	expect(bearers.session(issued[0])).toBeNull();
	expect(bearers.session(issued[1])).toBe("session-a");
	expect(bearers.session(issued[64])).toBe("session-a");
	const other = bearers.issue("session-b");
	expect(bearers.session(other)).toBe("session-b");
});

test("previous retires only a bearer of the same session", () => {
	const bearers = createBearers(() => 0);
	const a = bearers.issue("session-a");
	const b = bearers.issue("session-b");
	bearers.retire(b, "session-a");
	expect(bearers.session(b)).toBe("session-b");
	bearers.retire(a, "session-a");
	expect(bearers.session(a)).toBeNull();
	bearers.retire(undefined, "session-a");
	bearers.retireSessions(new Set(["session-b"]));
	expect(bearers.session(b)).toBeNull();
});

async function studio() {
	const directory = await createOwnerDirectory();
	cleanup.push(() => rm(directory, { recursive: true, force: true }));
	const bearers = createBearers();
	const retired: string[][] = [];
	const plain = await openInstallation(directory);
	cleanup.push(() => plain.close());
	const install: Installation = {
		...plain,
		retireSessions(digests) {
			retired.push([...digests]);
			bearers.retireSessions(digests);
		},
	};
	const access = createOwnerAccess(install, Date.now, "http://127.0.0.1", bearers);
	return { install, bearers, retired, access };
}

test("afterCommit runs after the commit's retirement, in the same storage turn", async () => {
	const { install, retired, access } = await studio();
	const claimed = await access.claim(access.rotate(), "owner", crypto.randomUUID(), "key-a");
	const order: string[] = [];
	await ownerTransaction(
		install,
		async (tx) => {
			await deleteOwnerSessions(tx, sql`public_key='key-a'`);
			order.push("work");
		},
		() => order.push(`after:${retired.length}`),
	);
	expect(order).toEqual(["work", "after:1"]);
	expect(retired).toEqual([[claimed.digest]]);
	// A failed transaction retires nothing and skips afterCommit.
	await expect(
		ownerTransaction(
			install,
			async () => {
				throw new Error("fixture");
			},
			() => order.push("never"),
		),
	).rejects.toThrow("fixture");
	expect(order).toHaveLength(2);
});

test("claim registers its bearer right after commit, so a retirement queued behind drops it", async () => {
	const { install, bearers, access } = await studio();
	const store = accessStore(install, bearers);
	// Both calls queue their storage turn synchronously: the claim first, the revocation next.
	const claim = store.claim("owner", "unused", "key-a", Date.now(), () => {});
	const revoked = ownerTransaction(install, (tx) => deleteOwnerSessions(tx));
	const claimed = await claim;
	if (!claimed) throw new Error("Expected the claim to win.");
	await revoked;
	expect(bearers.session(claimed.bearer)).toBeNull();
	expect(await access.session(claimed.bearer)).toBeNull();
});

test("a sign-in's bearer is registered in its commit, before any later revocation runs", async () => {
	const { install, bearers, access } = await studio();
	const password = crypto.randomUUID();
	await access.claim(access.rotate(), "owner", password, "key-a");
	const signedIn = await access.signIn("owner", password, "key-b");
	if (signedIn.kind !== "session") throw new Error("Expected a session.");
	await ownerTransaction(install, (tx) => deleteOwnerSessions(tx, sql`public_key='key-b'`));
	expect(bearers.session(signedIn.bearer)).toBeNull();
	// A resume reads and registers in one turn; the next revocation drops that bearer too.
	const resumed = await access.resume("key-a", undefined);
	if (!resumed) throw new Error("Expected the claim's session.");
	await ownerTransaction(install, (tx) => deleteOwnerSessions(tx, sql`public_key='key-a'`));
	expect(bearers.session(resumed.bearer)).toBeNull();
}, 30000);
