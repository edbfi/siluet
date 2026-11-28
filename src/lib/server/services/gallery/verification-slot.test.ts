import { expect, test } from "bun:test";
import { createVerificationSlot } from "./verification-slot";

test("verifications take turns in arrival order, and a failed one frees the slot", async () => {
	const verifyInTurn = createVerificationSlot();
	const signal = new AbortController().signal;
	const order: string[] = [];
	const gate = Promise.withResolvers<void>();
	const first = verifyInTurn(signal, async () => {
		order.push("first");
		await gate.promise;
		throw new Error("damaged");
	});
	const second = verifyInTurn(signal, async () => order.push("second"));
	const third = verifyInTurn(signal, async () => order.push("third"));
	await Bun.sleep(1);
	expect(order).toEqual(["first"]);
	gate.resolve();
	await expect(first).rejects.toThrow("damaged");
	await Promise.all([second, third]);
	expect(order).toEqual(["first", "second", "third"]);
	expect(await verifyInTurn(signal, async () => "free")).toBe("free");
});

test("an aborted caller leaves the queue at once, and an aborted signal never takes the slot", async () => {
	const verifyInTurn = createVerificationSlot();
	const gate = Promise.withResolvers<void>();
	const running = verifyInTurn(new AbortController().signal, () => gate.promise);
	const stop = new AbortController();
	let ran = false;
	const waiting = verifyInTurn(stop.signal, async () => {
		ran = true;
	});
	stop.abort(new Error("Siluet is stopping."));
	await expect(waiting).rejects.toThrow("Siluet is stopping.");
	await expect(verifyInTurn(stop.signal, async () => {})).rejects.toThrow("Siluet is stopping.");
	gate.resolve();
	await running;
	expect(ran).toBe(false);
	expect(await verifyInTurn(new AbortController().signal, async () => "next")).toBe("next");
});
