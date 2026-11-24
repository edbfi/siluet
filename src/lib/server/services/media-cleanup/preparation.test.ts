import { afterAll, beforeAll, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { readdir, rm, writeFile } from "node:fs/promises";
import sharp from "sharp";
import { createOwnerDirectory } from "../../../../../tests/fixtures/owner-directory";
import { openRuntimeInstallation, runtimeEntry } from "../../db/runtime-installation";
import { createScratchPool } from "../media-staging/scratch";
import { createStages } from "../media-staging/stages";
import { type Cleaners, createMediaPreparation, type PreparedMedia } from "./preparation";

const directory = await createOwnerDirectory();
const installation = await openRuntimeInstallation(directory);
const prepareMedia = createMediaPreparation(installation);
const signal = new AbortController().signal;
const keep = async (media: PreparedMedia) => media;
const prepare = (source: Uint8Array | ReadableStream<Uint8Array>, abort = signal) =>
	prepareMedia(source, abort, keep);
let png: Buffer;
let jpeg: Buffer;
beforeAll(async () => {
	const pixels = {
		create: { width: 16, height: 16, channels: 3 as const, background: "lavender" },
	};
	png = await sharp(pixels).png().toBuffer();
	jpeg = await sharp(pixels).jpeg().toBuffer();
});
afterAll(async () => {
	await installation.close();
	await rm(directory, { recursive: true, force: true });
});

const stalled = () => new ReadableStream<Uint8Array>({}, { highWaterMark: 0 });
const held = () => runtimeEntry(installation).preparation;

test("returns the verified copy and its SHA-256 using the actual image format", async () => {
	for (const [bytes, mime] of [
		[jpeg, "image/jpeg"],
		[png, "image/png"],
	] as const) {
		const prepared = await prepare(new Blob([new Uint8Array(bytes)]).stream());
		expect(prepared.mime).toBe(mime);
		expect(prepared.transform).toBe("none");
		expect(prepared.size).toBe(prepared.bytes.length);
		expect(prepared.bytes.byteOffset).toBe(0);
		expect(prepared.bytes.buffer.byteLength).toBe(prepared.size);
		expect(prepared.digest).toBe(createHash("sha256").update(prepared.bytes).digest("hex"));
		expect(await sharp(prepared.bytes).raw().toBuffer()).toEqual(
			await sharp(bytes).raw().toBuffer(),
		);
	}
	expect(held()).toBeUndefined();
});

test("a rotated JPEG reports its re-encode", async () => {
	const ifd = Buffer.from("01001201030001000000060000000000", "hex");
	const tiff = Buffer.concat([Buffer.from("49492a0008000000", "hex"), ifd, Buffer.alloc(2)]);
	const payload = Buffer.concat([Buffer.from("Exif\0\0"), tiff]);
	const header = Buffer.from([0xff, 0xe1, 0, 0]);
	header.writeUInt16BE(payload.length + 2, 2);
	const rotated = Buffer.concat([jpeg.subarray(0, 2), header, payload, jpeg.subarray(2)]);
	const prepared = await prepare(rotated);
	expect(prepared).toMatchObject({ mime: "image/jpeg", transform: "reencoded-rotation" });
});

test("reports the cleaner's fixed reason and advice and rejects other formats", async () => {
	await expect(prepare(Buffer.concat([png, Buffer.from("secret.jpg")]))).rejects.toMatchObject({
		code: "declined",
		message: "The PNG contains trailing data.",
		advice: "Export a fresh single-image PNG.",
	});
	await expect(prepare(Buffer.from("secret.jpg"))).rejects.toMatchObject({ code: "format" });
});

test("slot taken before the body is read; a second request is refused", async () => {
	let pulls = 0;
	let cancelled = false;
	const body = new ReadableStream<Uint8Array>(
		{
			pull() {
				pulls++;
			},
			cancel() {
				cancelled = true;
			},
		},
		{ highWaterMark: 0 },
	);
	const controller = new AbortController();
	const pending = prepare(body, controller.signal);
	expect(held()).toBeDefined();
	let unread = 0;
	const second = new ReadableStream<Uint8Array>(
		{
			pull() {
				unread++;
			},
		},
		{ highWaterMark: 0 },
	);
	await expect(prepare(second)).rejects.toMatchObject({ code: "busy" });
	expect(unread).toBe(0);
	controller.abort("secret.jpg");
	await expect(pending).rejects.toMatchObject({ code: "cancelled" });
	expect(pulls).toBeGreaterThan(0);
	expect(cancelled).toBe(true);
	await held()?.settled;
	expect((await prepare(png)).mime).toBe("image/png");
});

test("re-imported module sees the slot held", async () => {
	const controller = new AbortController();
	const pending = prepare(stalled(), controller.signal);
	const reloaded = await import(`./preparation.ts?reload=${crypto.randomUUID()}`);
	const other = reloaded.createMediaPreparation(installation);
	await expect(other(jpeg, signal, keep)).rejects.toMatchObject({ code: "busy" });
	controller.abort();
	await expect(pending).rejects.toMatchObject({ code: "cancelled" });
	await held()?.settled;
	expect((await other(jpeg, signal, keep)).mime).toBe("image/jpeg");
});

test("cancel releases only after sharp settles", async () => {
	const decode = Promise.withResolvers<{ bytes: Uint8Array; transform: "none" }>();
	const started = Promise.withResolvers<void>();
	const cleaners: Cleaners = {
		jpeg: () => {
			started.resolve();
			return decode.promise;
		},
		png: async (bytes) => bytes,
		original: async (bytes) => ({ bytes, transform: "original", rotated: false }),
	};
	const stubbed = createMediaPreparation(installation, { cleaners });
	const controller = new AbortController();
	const pending = stubbed(jpeg, controller.signal, keep);
	await started.promise;
	controller.abort();
	await expect(pending).rejects.toMatchObject({ code: "cancelled" });
	const slot = held();
	expect(slot).toBeDefined();
	await expect(prepare(png)).rejects.toMatchObject({ code: "busy" });
	decode.resolve({ bytes: jpeg, transform: "none" });
	await slot?.settled;
	expect(held()).toBeUndefined();
	expect((await prepare(png)).mime).toBe("image/png");
});

test("a second request is refused while the first stages.put() write stalls", async () => {
	const write = Promise.withResolvers<void>();
	const entered = Promise.withResolvers<void>();
	const pending = prepareMedia(png, signal, async (media) => {
		entered.resolve();
		await write.promise;
		return media.size;
	});
	await entered.promise;
	await expect(prepare(jpeg)).rejects.toMatchObject({ code: "busy" });
	write.resolve();
	expect(await pending).toBeGreaterThan(0);
	await held()?.settled;
	expect((await prepare(jpeg)).mime).toBe("image/jpeg");
});

test("a stage write that crosses the deadline publishes nothing and holds the slot until it settles", async () => {
	const scratch = createScratchPool(installation);
	await scratch.reclaim();
	const scope = await scratch.scope("image");
	const write = Promise.withResolvers<void>();
	const entered = Promise.withResolvers<void>();
	const stages = createStages(scope, {
		writeFile: async (path, bytes) => {
			entered.resolve();
			await write.promise;
			await writeFile(path, bytes, { flag: "wx", mode: 0o600 });
		},
	});
	const quick = createMediaPreparation(installation, { deadlineMs: 100 });
	const draft = { owner: "owner", session: "session", draft: crypto.randomUUID() };
	const pending = quick(png, signal, (media, stop) => stages.put(draft, media, stop));
	pending.catch(() => {});
	await entered.promise;
	await Bun.sleep(200);
	// The deadline has passed, but the write still holds the slot.
	await expect(prepare(jpeg)).rejects.toMatchObject({ code: "busy" });
	write.resolve();
	await expect(pending).rejects.toMatchObject({ code: "timeout" });
	await held()?.settled;
	expect(held()).toBeUndefined();
	expect(scratch.used).toBe(0);
	expect(await readdir(scope.directory)).toEqual([]);
	await stages.close();
});

test("a deadline that passes before its timer fires publishes nothing and reports a timeout", async () => {
	let clock = 0;
	const scratch = createScratchPool(installation);
	await scratch.reclaim();
	const scope = await scratch.scope("image");
	const stages = createStages(scope, {
		monotonic: () => clock,
		writeFile: async (path, bytes) => {
			// The deadline passes during the write. The 30 s timer cannot have fired.
			clock = 31_000;
			await writeFile(path, bytes, { flag: "wx", mode: 0o600 });
		},
	});
	const timed = createMediaPreparation(installation, { monotonic: () => clock });
	const draft = { owner: "owner", session: "session", draft: crypto.randomUUID() };
	await expect(
		timed(png, signal, (media, stop) => stages.put(draft, media, stop)),
	).rejects.toMatchObject({ code: "timeout" });
	await held()?.settled;
	expect(scratch.used).toBe(0);
	expect(await readdir(scope.directory)).toEqual([]);
	await stages.close();
});

test("30 s → timeout, counted from admission through a trickled body", async () => {
	const quick = createMediaPreparation(installation, { deadlineMs: 150 });
	let timer: ReturnType<typeof setInterval> | undefined;
	let cancelled = false;
	const trickle = new ReadableStream<Uint8Array>({
		start(controller) {
			timer = setInterval(() => controller.enqueue(new Uint8Array([0xff])), 20);
		},
		cancel() {
			cancelled = true;
			clearInterval(timer);
		},
	});
	const started = performance.now();
	await expect(quick(trickle, signal, keep)).rejects.toMatchObject({ code: "timeout" });
	clearInterval(timer);
	expect(performance.now() - started).toBeLessThan(2_000);
	expect(cancelled).toBe(true);
	await held()?.settled;
	expect(held()).toBeUndefined();
});

test("one decode in flight under 4 requests", async () => {
	let active = 0;
	let peak = 0;
	const cleaners: Cleaners = {
		jpeg: async (bytes) => {
			peak = Math.max(peak, ++active);
			await Bun.sleep(30);
			active--;
			return { bytes, transform: "none" };
		},
		png: async (bytes) => bytes,
		original: async (bytes) => ({ bytes, transform: "original", rotated: false }),
	};
	const counted = createMediaPreparation(installation, { cleaners });
	const results = await Promise.allSettled(
		Array.from({ length: 4 }, () => counted(jpeg, signal, keep)),
	);
	expect(results.filter(({ status }) => status === "fulfilled")).toHaveLength(1);
	expect(
		results.filter(
			(result) =>
				result.status === "rejected" &&
				(result.reason as { code?: string } | undefined)?.code === "busy",
		),
	).toHaveLength(3);
	expect(peak).toBe(1);
});

test("a body whose cancelled read never settles does not hold the slot", async () => {
	const controller = new AbortController();
	const body = new ReadableStream<Uint8Array>({
		pull: () => new Promise(() => {}),
		cancel: () => new Promise(() => {}),
	});
	const pending = prepare(body, controller.signal);
	controller.abort();
	await expect(pending).rejects.toMatchObject({ code: "cancelled" });
	await held()?.settled;
	expect(held()).toBeUndefined();
});

test("shutdown cancels preparation while its request body is stalled", async () => {
	const shutdown = new AbortController();
	const stopping = createMediaPreparation(installation, { shutdown: shutdown.signal });
	const pending = stopping(stalled(), signal, keep);
	shutdown.abort();
	await expect(pending).rejects.toMatchObject({ code: "cancelled" });
	await expect(stopping(png, signal, keep)).rejects.toMatchObject({ code: "cancelled" });
	await held()?.settled;
});

test("bounds streamed bytes before decode and cancels the source", async () => {
	let cancelled = false;
	const body = new ReadableStream<Uint8Array>({
		pull(controller) {
			controller.enqueue(new Uint8Array(1024 * 1024));
		},
		cancel() {
			cancelled = true;
		},
	});
	await expect(prepare(body)).rejects.toMatchObject({ code: "limit" });
	expect(cancelled).toBe(true);
});

test("staging receives the cleaned bytes, and their digest differs from the unchanged marked source", async () => {
	const marker = Buffer.from("private-output-name.jpg");
	const header = Buffer.from([255, 254, 0, marker.length + 2]);
	const marked = Buffer.concat([jpeg.subarray(0, 2), header, marker, jpeg.subarray(2)]);
	const originalDigest = createHash("sha256").update(marked).digest("hex");
	const prepared = await prepare(marked);
	expect(Buffer.from(prepared.bytes).includes(marker)).toBe(false);
	expect(prepared.digest).not.toBe(originalDigest);
	expect(createHash("sha256").update(marked).digest("hex")).toBe(originalDigest);
});

test("a stage error from the commit reaches the caller unchanged", async () => {
	const full = new Error("Local scratch full.");
	await expect(
		prepareMedia(png, signal, async () => {
			throw full;
		}),
	).rejects.toBe(full);
});

test("PNG original keeps transform original", async () => {
	const off = createMediaPreparation(installation, {
		readCleaning: async () => ({ enabled: false, revision: 4 }),
	});
	for (const [bytes, mime] of [
		[png, "image/png"],
		[jpeg, "image/jpeg"],
	] as const) {
		const prepared = await off(bytes, signal, keep);
		expect(prepared).toMatchObject({ mime, transform: "original", revision: 4, rotated: false });
		expect(Buffer.from(prepared.bytes).equals(bytes)).toBe(true);
		await held()?.settled;
	}
	const on = await createMediaPreparation(installation, {
		readCleaning: async () => ({ enabled: true, revision: 5 }),
	})(png, signal, keep);
	expect(on).toMatchObject({ transform: "none", revision: 5, rotated: false });
	await held()?.settled;
});

test("an unreadable cleaning setting refuses preparation and frees the slot", async () => {
	const prepareWithout = createMediaPreparation(installation, {
		readCleaning: async () => {
			throw new Error("Cleaning setting unavailable.");
		},
	});
	await expect(prepareWithout(png, signal, keep)).rejects.toMatchObject({ code: "failed" });
	await held()?.settled;
	expect(held()).toBeUndefined();
});

test("an original's cancel and timeout hold the slot until its decode settles", async () => {
	for (const stop of ["cancel", "timeout"] as const) {
		const decode = Promise.withResolvers<{
			bytes: Uint8Array;
			transform: "original";
			rotated: boolean;
		}>();
		const started = Promise.withResolvers<void>();
		const stubbed = createMediaPreparation(installation, {
			readCleaning: async () => ({ enabled: false, revision: 0 }),
			deadlineMs: stop === "timeout" ? 30 : 30_000,
			cleaners: {
				jpeg: async () => ({ bytes: jpeg, transform: "none" }),
				png: async (bytes) => bytes,
				original: () => {
					started.resolve();
					return decode.promise;
				},
			},
		});
		const controller = new AbortController();
		const pending = stubbed(jpeg, controller.signal, keep);
		await started.promise;
		if (stop === "cancel") controller.abort();
		await expect(pending).rejects.toMatchObject({
			code: stop === "cancel" ? "cancelled" : "timeout",
		});
		const slot = held();
		expect(slot).toBeDefined();
		await expect(prepare(png)).rejects.toMatchObject({ code: "busy" });
		decode.resolve({ bytes: jpeg, transform: "original", rotated: false });
		await slot?.settled;
		expect(held()).toBeUndefined();
	}
});

test("sharp.cache off", () => {
	const { memory, files, items } = sharp.cache();
	expect([memory.max, files.max, items.max]).toEqual([0, 0, 0]);
});
