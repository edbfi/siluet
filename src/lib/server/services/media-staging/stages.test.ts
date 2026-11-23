import { afterEach, expect, jest, test } from "bun:test";
import { createHash } from "node:crypto";
import { readdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { createOwnerDirectory } from "../../../../../tests/fixtures/owner-directory";
import type { MediaDescriptor } from "../../../shared/media-staging/descriptor";
import { openRuntimeInstallation } from "../../db/runtime-installation";
import { createScratchPool } from "./scratch";
import { createStages, type StageOptions, stageIdleMs } from "./stages";

const cleanup: (() => Promise<void>)[] = [];
afterEach(async () => {
	for (const step of cleanup.splice(0).reverse()) await step();
});

async function setup(bytes: number, options: StageOptions = {}) {
	const root = await createOwnerDirectory();
	cleanup.push(() => rm(root, { recursive: true, force: true }));
	const installation = await openRuntimeInstallation(root);
	cleanup.push(() => installation.close());
	const pool = createScratchPool(installation, { bytes });
	await pool.reclaim();
	const scratch = await pool.scope("image");
	const stages = createStages(scratch, options);
	cleanup.push(() => stages.close());
	return { root, pool, scratch, stages, files: () => readdir(scratch.directory) };
}

function png(...values: number[]) {
	const bytes = new Uint8Array(values);
	return {
		bytes,
		size: bytes.length,
		mime: "image/png" as const,
		transform: "none" as const,
		revision: 0,
		rotated: false,
		digest: createHash("sha256").update(bytes).digest("hex"),
	};
}
const scope = () => ({ owner: "creator", session: "session", draft: crypto.randomUUID() });

test("only the reviewing session and draft can use the verified bytes, within independent quotas", async () => {
	let clock = 10;
	const { stages, scratch, files } = await setup(6, { now: () => clock, buffers: 6 });
	const owner = scope();
	const other = scope();
	const media = png(1, 2, 3);
	const a = await stages.put(owner, media);
	const b = await stages.put(other, media);
	expect(a).toMatchObject({ mime: "image/png", transform: "none", size: 3, draft: owner.draft });
	await expect(stages.put(scope(), media)).rejects.toThrow("Local scratch full");
	expect(await files()).toHaveLength(2);
	expect(await stages.preview({ ...owner, session: "other" }, a.handle)).toBeNull();
	expect(await stages.preview(other, a.handle)).toBeNull();
	const earlier = await stages.review(owner, a.handle);
	clock += 1;
	const later = await stages.review(owner, a.handle);
	if (!earlier || !later) throw new Error("Missing file Review");
	expect(later.deadline).toBe(earlier.deadline + 1);
	expect(
		await stages.review(owner, a.handle, {
			...later,
			mime: "image/jpeg",
			transform: "reencoded-rotation",
		}),
	).toBe(null);
	const held = await stages.claim(owner, later, async () => true);
	if (!held) throw new Error("expected bytes");
	expect([...held.bytes]).toEqual([1, 2, 3]);
	await writeFile(join(scratch.directory, b.handle), new Uint8Array([0, 0, 0]));
	await expect(stages.claim(other, b, async () => true)).rejects.toThrow("changed");
	held.release();
	clock = b.deadline;
	expect(await stages.preview(other, b.handle)).toBeNull();
});

test("full pool refuses before writing; drafts survive; release lets staging succeed", async () => {
	const { stages, pool, files } = await setup(6);
	const first = scope();
	const kept = await stages.put(first, png(1, 2, 3));
	const second = await stages.put(scope(), png(4, 5, 6));
	expect(pool.used).toBe(6);
	const third = scope();
	await expect(stages.put(third, png(7))).rejects.toThrow("Local scratch full");
	// Replacing a draft in a full pool also refuses and keeps the earlier copy.
	await expect(stages.put(first, png(8))).rejects.toThrow("Local scratch full");
	expect((await files()).sort()).toEqual([kept.handle, second.handle].sort());
	expect(await stages.preview(first, kept.handle)).toMatchObject({ mime: "image/png" });
	await stages.discardDraft(first);
	expect(pool.used).toBe(3);
	await stages.put(third, png(7));
	expect(pool.used).toBe(4);
});

test("unlink failure stays charged until a retry succeeds", async () => {
	let refuse = 6;
	const attempts: string[] = [];
	const { stages, pool, files } = await setup(4, {
		retryDelays: [1, 1, 1],
		removeFile: async (path) => {
			attempts.push(path);
			if (refuse-- > 0) throw new Error("EBUSY");
			await rm(path, { force: true });
		},
	});
	const owner = scope();
	const staged = await stages.put(owner, png(1, 2, 3));
	await stages.discardDraft(owner);
	expect(attempts).toHaveLength(4);
	expect(await files()).toEqual([staged.handle]);
	expect(pool.used).toBe(3);
	expect(await stages.preview(owner, staged.handle)).toBeNull();
	await expect(stages.put(scope(), png(1, 2))).rejects.toThrow("Local scratch full");
	// The next sweep retries the leftover once before staging.
	await expect(stages.put(scope(), png(1, 2))).rejects.toThrow("Local scratch full");
	expect(pool.used).toBe(3);
	await stages.put(scope(), png(1));
	expect(pool.used).toBe(1);
	expect(await files()).not.toContain(staged.handle);
});

test("cancelled claim holds its buffer until the read settles", async () => {
	const gate = Promise.withResolvers<void>();
	const entered = Promise.withResolvers<void>();
	const { stages } = await setup(16, {
		buffers: 4,
		pace: async () => {
			entered.resolve();
			await gate.promise;
		},
	});
	const owner = scope();
	const staged = await stages.put(owner, png(1, 2, 3, 4));
	let commits = 0;
	const pending = stages.claim(owner, staged, async () => {
		commits++;
		return true;
	});
	await entered.promise;
	expect(stages.buffered).toBe(4);
	await stages.revoke(owner.session);
	expect(stages.buffered).toBe(4);
	const other = scope();
	const next = await stages.put(other, png(5, 6, 7, 8));
	await expect(stages.claim(other, next, async () => true)).rejects.toThrow("Upload busy");
	gate.resolve();
	expect(await pending).toBeNull();
	expect(commits).toBe(0);
	expect(stages.buffered).toBe(0);
	const held = await stages.claim(other, next, async () => true);
	expect(held?.bytes).toEqual(new Uint8Array([5, 6, 7, 8]));
	held?.release();
});

test("distinct drafts share buffer capacity, preserve refused stages and send immutable snapshots", async () => {
	const { stages, scratch } = await setup(9, { buffers: 6 });
	const [a, b, c] = [scope(), scope(), scope()];
	const media = png(2, 4, 6);
	const [da, db, dc] = await Promise.all([a, b, c].map((s) => stages.put(s, media)));
	let claims = 0;
	const [one, two] = await Promise.all([
		stages.claim(a, da, async () => {
			claims++;
			await writeFile(join(scratch.directory, da.handle), new Uint8Array([9, 9, 9]));
			return true;
		}),
		stages.claim(b, db, async () => {
			claims++;
			return true;
		}),
	]);
	if (!one || !two) throw new Error("Missing transfer");
	expect([...one.bytes]).toEqual([2, 4, 6]);
	await expect(
		stages.claim(c, dc, async () => {
			claims++;
			return true;
		}),
	).rejects.toThrow("Upload busy · nothing sent");
	expect(claims).toBe(2);
	expect(await stages.preview(c, dc.handle)).toBeTruthy();
	one.release();
	const again = await stages.claim(c, dc, async () => {
		claims++;
		return true;
	});
	expect(claims).toBe(3);
	two.release();
	again?.release();
});

test("a later Review extends idle staging but never the first Review deadline", async () => {
	let now = 10;
	const { stages } = await setup(16, { now: () => now });
	const owner = scope();
	const descriptor = await stages.put(owner, png(1));
	now += 20;
	const fresh = await stages.review(owner, descriptor.handle);
	if (!fresh) throw new Error("Missing explicit Review");
	now = descriptor.deadline;
	expect(await stages.preview(owner, descriptor.handle)).toBeTruthy();
	expect(await stages.claim(owner, descriptor, async () => true)).toBeNull();
	now = fresh.deadline;
	expect(await stages.claim(owner, fresh, async () => true)).toBeNull();
	expect(await stages.preview(owner, descriptor.handle)).toBeNull();
});

test("an idle copy still expires when its timer fires early after the clock steps back", async () => {
	let now = 1_000_000;
	const { stages, files } = await setup(16, { now: () => now });
	jest.useFakeTimers();
	try {
		const descriptor = await stages.put(scope(), png(1));
		// The idle period passes, but the wall clock stepped back by a minute meanwhile.
		now = descriptor.deadline - 60_000;
		jest.advanceTimersByTime(stageIdleMs);
		for (let i = 0; i < 10; i++) await Promise.resolve();
		expect(await files()).toHaveLength(1);
		now = descriptor.deadline;
		jest.advanceTimersByTime(60_000);
		for (let i = 0; i < 50 && (await files()).length; i++);
		expect(await files()).toHaveLength(0);
	} finally {
		jest.useRealTimers();
	}
});

test("a full scratch pool still supplies dispatch buffers", async () => {
	const { stages } = await setup(12, { buffers: 6 });
	const entries: { owner: ReturnType<typeof scope>; stage: MediaDescriptor }[] = [];
	for (let i = 0; i < 4; i++) {
		const owner = scope();
		entries.push({ owner, stage: await stages.put(owner, png(i, i, i)) });
	}
	await expect(stages.put(scope(), png(1))).rejects.toThrow("Local scratch full");
	const claim = (index: number) =>
		stages.claim(entries[index].owner, entries[index].stage, async () => true);
	const [first, second] = await Promise.all([claim(0), claim(1)]);
	if (!first || !second) throw new Error("Missing transfers at capacity");
	await expect(claim(2)).rejects.toThrow("Upload busy");
	first.release();
	const third = await claim(2);
	if (!third) throw new Error("Same Review should remain usable");
	second.release();
	third.release();
	await stages.put(scope(), png(1));
});

test("a missing scratch file refuses a claim and its reservation can be reclaimed", async () => {
	const { stages, scratch } = await setup(1, { buffers: 1 });
	const owner = scope();
	const descriptor = await stages.put(owner, png(1));
	await rm(join(scratch.directory, descriptor.handle));
	let claims = 0;
	await expect(
		stages.claim(owner, descriptor, async () => {
			claims++;
			return true;
		}),
	).rejects.toThrow("Staged file changed.");
	expect(claims).toBe(0);
	await stages.discardDraft(owner);
	const next = scope();
	const replacement = await stages.put(next, png(1));
	const held = await stages.claim(next, replacement, async () => true);
	expect(held?.bytes).toEqual(new Uint8Array([1]));
	held?.release();
});

test("closing removes every staged file and returns its space", async () => {
	const { stages, pool, files } = await setup(8);
	await stages.put(scope(), png(1, 2));
	await stages.put(scope(), png(3));
	await stages.close();
	expect(await files()).toEqual([]);
	expect(pool.used).toBe(0);
	await expect(stages.put(scope(), png(1))).rejects.toThrow("Stage unavailable");
});

test("closing stops open previews at once, before a queued write settles", async () => {
	const write = Promise.withResolvers<void>();
	const entered = Promise.withResolvers<void>();
	let stall = false;
	const { stages, files } = await setup(8, {
		writeFile: async (path, bytes) => {
			if (stall) {
				entered.resolve();
				await write.promise;
			}
			await writeFile(path, bytes, { flag: "wx", mode: 0o600 });
		},
	});
	const owner = scope();
	const staged = await stages.put(owner, png(1, 2));
	const lease = await stages.openPreview(owner, staged.handle);
	if (!lease) throw new Error("missing stage");
	stall = true;
	const queued = stages.put(scope(), png(3)).catch(() => null);
	await entered.promise;
	const closed = stages.close();
	expect(lease.signal.aborted).toBe(true);
	write.resolve();
	await Promise.all([queued, closed]);
	await lease.handle.close();
	expect(await files()).toEqual([]);
});

test("discarding a draft removes its copies and refuses a later write to that draft", async () => {
	let time = 1;
	const { stages, files, pool } = await setup(8, { now: () => time });
	const owner = scope();
	const kept = scope();
	await stages.put(owner, png(1, 2));
	const other = await stages.put(kept, png(3));
	// A request the browser abandoned can still reach the store after the discard.
	await stages.discardDraft({ ...owner, session: "other" });
	expect(await files()).toHaveLength(2);
	await stages.discardDraft(owner);
	await expect(stages.put(owner, png(4))).rejects.toThrow("Stage unavailable");
	expect(await files()).toEqual([other.handle]);
	expect(pool.used).toBe(1);
	// The refusal lasts as long as an idle copy would.
	time += 15 * 60_000;
	expect((await stages.put(owner, png(5))).size).toBe(1);
});

test("a stop during session validation writes no file and charges no scratch", async () => {
	let writes = 0;
	const { stages, pool, files } = await setup(8, {
		writeFile: async (path, bytes) => {
			writes++;
			await writeFile(path, bytes, { flag: "wx", mode: 0o600 });
		},
	});
	const stopped = new AbortController();
	await expect(
		stages.put(scope(), png(1, 2), {
			signal: stopped.signal,
			valid: async () => {
				stopped.abort();
				return true;
			},
		}),
	).rejects.toThrow("Stage unavailable");
	const owner = scope();
	await expect(
		stages.put(owner, png(3), {
			valid: async () => {
				void stages.discardDraft(owner);
				return true;
			},
		}),
	).rejects.toThrow("Stage unavailable");
	expect(writes).toBe(0);
	expect(pool.used).toBe(0);
	expect(await files()).toEqual([]);
});

test("a passed preparation deadline publishes nothing even before its timer fires", async () => {
	let clock = 0;
	const { stages, pool, files } = await setup(8, {
		monotonic: () => clock,
		writeFile: async (path, bytes) => {
			clock = 100;
			await writeFile(path, bytes, { flag: "wx", mode: 0o600 });
		},
	});
	const owner = scope();
	await expect(stages.put(owner, png(1, 2), { deadline: 50 })).rejects.toThrow("Stage unavailable");
	expect(pool.used).toBe(0);
	expect(await files()).toEqual([]);
	await expect(stages.put(owner, png(1, 2), { deadline: 50 })).rejects.toThrow("Stage unavailable");
});
