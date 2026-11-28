import { expect, test } from "bun:test";
import { createSlots } from "./slots";

const open = () => new AbortController().signal;

test("one slot takes turns in arrival order, and a failed holder frees it", async () => {
	const slots = createSlots(1);
	const order: string[] = [];
	const gate = Promise.withResolvers<void>();
	const first = slots.run(open(), async () => {
		order.push("first");
		await gate.promise;
		throw new Error("damaged");
	});
	const second = slots.run(open(), async () => order.push("second"));
	const third = slots.run(open(), async () => order.push("third"));
	await Bun.sleep(1);
	expect(order).toEqual(["first"]);
	gate.resolve();
	await expect(first).rejects.toThrow("damaged");
	await Promise.all([second, third]);
	expect(order).toEqual(["first", "second", "third"]);
	expect(await slots.run(open(), async () => "free")).toBe("free");
});

test("two slots admit two holders; a release, once only, admits the next", async () => {
	const slots = createSlots(2);
	const first = await slots.take(open());
	await slots.take(open());
	let third = false;
	const waiting = slots.take(open()).then((release) => {
		third = true;
		return release;
	});
	await Bun.sleep(1);
	expect([slots.held(), third]).toEqual([2, false]);
	first();
	first();
	(await waiting)();
	expect([slots.held(), third]).toEqual([1, true]);
	let fourth = false;
	const late = slots.take(open()).then(() => {
		fourth = true;
	});
	await Bun.sleep(1);
	expect(fourth).toBe(true);
	await late;
});

test("an aborted caller leaves the queue at once, and an aborted signal never takes a slot", async () => {
	const slots = createSlots(1);
	const gate = Promise.withResolvers<void>();
	const running = slots.run(open(), () => gate.promise);
	const stop = new AbortController();
	let ran = false;
	const waiting = slots.run(stop.signal, async () => {
		ran = true;
	});
	stop.abort(new Error("Siluet is stopping."));
	await expect(waiting).rejects.toThrow("Siluet is stopping.");
	await expect(slots.run(stop.signal, async () => {})).rejects.toThrow("Siluet is stopping.");
	gate.resolve();
	await running;
	expect(ran).toBe(false);
	expect(await slots.run(open(), async () => "next")).toBe("next");
});

test("a slot handed to a caller whose signal has just aborted is released, and its work never runs", async () => {
	const slots = createSlots(1);
	const release = await slots.take(open());
	const stop = new AbortController();
	let ran = false;
	const waiting = slots.run(stop.signal, async () => {
		ran = true;
	});
	// The holder hands the slot over, and the waiter's signal aborts before it can run.
	release();
	stop.abort(new Error("The client went away."));
	await expect(waiting).rejects.toThrow("The client went away.");
	expect([ran, slots.held()]).toEqual([false, 0]);
});
