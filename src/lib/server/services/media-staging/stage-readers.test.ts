import { expect, test } from "bun:test";
import type { BigIntStats } from "node:fs";
import type { FileHandle } from "node:fs/promises";
import { stageReaders } from "./stage-readers";

const identity = { isFile: () => true, dev: 1n, ino: 2n, ctimeNs: 3n, mtimeNs: 4n, size: 1n };

function fakeFile(events: string[], { close = async () => {} } = {}) {
	const read = Promise.withResolvers<void>();
	const file = {
		stat: async () => {
			events.push("stat");
			return identity;
		},
		read: async () => {
			events.push("read");
			await read.promise;
			events.push("read settled");
			return { bytesRead: 1 };
		},
		close: async () => {
			events.push("close");
			await close();
		},
	};
	return { file: file as unknown as FileHandle, finishRead: () => read.resolve() };
}

test("a close that races a preview read waits for the read before closing the file", async () => {
	const events: string[] = [];
	const { file, finishRead } = fakeFile(events);
	const readers = stageReaders(
		"stage",
		identity as unknown as BigIntStats,
		() => {},
		async () => file,
	);
	const reader = await readers.open();
	const pending = reader.read(new Uint8Array(1), 0, 1, 0).catch(() => "aborted");
	const closed = reader.close();
	const retired = readers.retire();
	await Bun.sleep(20);
	expect(events).toEqual(["stat", "read"]);
	finishRead();
	await Promise.all([closed, retired]);
	expect(await pending).toBe("aborted");
	// The identity check after the read also finishes before the file closes.
	expect(events).toEqual(["stat", "read", "read settled", "stat", "close"]);
	await expect(reader.read(new Uint8Array(1), 0, 1, 0)).rejects.toThrow();
});

test("retire settles even when a file close fails", async () => {
	const events: string[] = [];
	const { file } = fakeFile(events, {
		close: async () => {
			throw Object.assign(new Error("busy"), { code: "EBUSY" });
		},
	});
	const readers = stageReaders(
		"stage",
		identity as unknown as BigIntStats,
		() => {},
		async () => file,
	);
	await readers.open();
	await readers.open();
	await readers.retire();
	expect(events).toEqual(["stat", "stat", "close", "close"]);
});
