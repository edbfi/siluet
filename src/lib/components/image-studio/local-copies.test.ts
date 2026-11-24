import { expect, test } from "bun:test";
import { oneAtATime, PendingDeletes, SlotFiles } from "./local-copies";

const file = (name: string) => new File([name], `${name}.png`, { type: "image/png" });

test("slots share one copy per File and dispose it when the last slot leaves", () => {
	const created: string[] = [];
	const disposed: string[] = [];
	const slots = new SlotFiles(
		(f: File) => {
			created.push(f.name);
			return { name: f.name };
		},
		(copy) => disposed.push(copy.name),
	);
	const a = file("a");
	const b = file("b");
	slots.sync([{ key: 1, file: a }, null, { key: 3, file: b }, { key: 4, file: a }]);
	expect(created).toEqual(["a.png", "b.png"]);
	expect(slots.files.map(({ position, key, copy }) => [position, key, copy.name])).toEqual([
		[1, 1, "a.png"],
		[3, 3, "b.png"],
		[4, 4, "a.png"],
	]);
	// The same File in two slots is a duplicate, by position.
	expect(slots.duplicates()).toEqual([1, 4]);
	slots.sync([
		{ key: 3, file: b },
		{ key: 4, file: a },
	]);
	expect(disposed).toEqual([]);
	expect(slots.files.map(({ position }) => position)).toEqual([1, 2]);
	expect(slots.duplicates()).toEqual([]);
	slots.sync([{ key: 3, file: b }]);
	expect(disposed).toEqual(["a.png"]);
	// A new File in a slot replaces its copy.
	slots.sync([{ key: 3, file: file("c") }]);
	expect(disposed).toEqual(["a.png", "b.png"]);
	slots.clear();
	expect(disposed).toEqual(["a.png", "b.png", "c.png"]);
});

test("equal digests in different files are duplicates too", () => {
	const slots = new SlotFiles(
		(f: File) => ({ digest: f.name.startsWith("x") ? "same" : f.name }),
		() => {},
	);
	slots.sync([
		{ key: 1, file: file("x1") },
		{ key: 2, file: file("y") },
		{ key: 3, file: file("x2") },
	]);
	expect(slots.duplicates((copy) => copy.digest)).toEqual([1, 3]);
});

test("preparations run one at a time, in the order they were asked for", async () => {
	const turn = oneAtATime();
	const order: string[] = [];
	const gate = Promise.withResolvers<void>();
	const first = turn(async () => {
		order.push("1 start");
		await gate.promise;
		order.push("1 end");
	});
	const second = turn(async () => {
		order.push("2");
	});
	const failing = turn(async () => {
		throw new Error("refused");
	});
	const third = turn(async () => {
		order.push("3");
	});
	await Bun.sleep(1);
	expect(order).toEqual(["1 start"]);
	gate.resolve();
	await Promise.all([first, second, third, failing.catch(() => {})]);
	expect(order).toEqual(["1 start", "1 end", "2", "3"]);
});

test("a preparation after a flip waits for every earlier deletion to settle", async () => {
	const deletes = new PendingDeletes();
	const slow = Promise.withResolvers<void>();
	deletes.track(slow.promise);
	deletes.track(Promise.reject(new Error("offline")));
	let settled = false;
	const waiting = deletes.settled().then(() => {
		settled = true;
	});
	await Bun.sleep(1);
	expect(settled).toBeFalse();
	slow.resolve();
	await waiting;
	expect(settled).toBeTrue();
	await deletes.settled();
});
