import { expect, test } from "bun:test";
import { BodyLimitError, readBounded } from "./read-bounded";

function chunks(values: unknown[], close = false) {
	let cancelled = false;
	const stream = new ReadableStream({
		start(controller) {
			for (const value of values) controller.enqueue(value);
			if (close) controller.close();
		},
		cancel() {
			cancelled = true;
		},
	});
	return { stream, cancelled: () => cancelled };
}

test("reads up to the limit and cancels a stream that exceeds it", async () => {
	const exact = chunks([new Uint8Array([1, 2]), new Uint8Array([3])], true);
	expect([...(await readBounded(exact.stream, 3))]).toEqual([1, 2, 3]);
	const over = chunks([new Uint8Array(3), new Uint8Array(1)]);
	await expect(readBounded(over.stream, 3)).rejects.toBeInstanceOf(BodyLimitError);
	expect(over.cancelled()).toBeTrue();
});

test("refuses non-byte chunks and stops when its check or signal does", async () => {
	const text = chunks(["text"]);
	await expect(readBounded(text.stream, 10)).rejects.toBeInstanceOf(TypeError);
	expect(text.cancelled()).toBeTrue();

	const stopped = chunks([new Uint8Array(1)]);
	await expect(
		readBounded(stopped.stream, 10, () => {
			throw new Error("stopped");
		}),
	).rejects.toThrow("stopped");
	expect(stopped.cancelled()).toBeTrue();

	const pending = chunks([]);
	const abort = new AbortController();
	const read = readBounded(pending.stream, 10, undefined, abort.signal);
	abort.abort();
	await read.catch(() => {});
	expect(pending.cancelled()).toBeTrue();
});

test("cancels at once and refuses a body whose signal has already aborted", async () => {
	const waiting = chunks([new Uint8Array(1)]);
	const aborted = AbortSignal.abort(new Error("aborted"));
	await expect(readBounded(waiting.stream, 10, undefined, aborted)).rejects.toThrow("aborted");
	expect(waiting.cancelled()).toBeTrue();
}, 1000);
