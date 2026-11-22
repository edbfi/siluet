// Run after `bun run --bun build`. Drives the signed-in staging route on the built adapter.
import { afterEach, expect, test } from "bun:test";
import { type ChildProcess, fork } from "node:child_process";
import { once } from "node:events";
import { mkdir, readdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { createInterface } from "node:readline";
import sharp from "sharp";
import { createOwnerDirectory } from "../fixtures/owner-directory";

const root = join(import.meta.dir, "../..");
const cleanup: (() => Promise<unknown>)[] = [];
afterEach(async () => {
	for (const step of cleanup.splice(0).reverse()) await step();
});

type Studio = Awaited<ReturnType<typeof launch>>;
async function launch(directory: string) {
	const child: ChildProcess = fork(join(root, "scripts/start.ts"), [], {
		execPath: process.execPath,
		execArgv: ["--preload", join(root, "tests/browser/launcher-control.ts")],
		cwd: root,
		env: { ...process.env, SILUET_DATA_DIR: directory, SILUET_SERVER_PORT: "0" },
		stdio: ["ignore", "pipe", "pipe", "ipc"],
	});
	let output = "";
	let token = "";
	const listening = Promise.withResolvers<string>();
	const closed = once(child, "close").then(([code]) => code as number | null);
	closed.then(() => listening.reject(new Error(`Studio stopped before it was ready:\n${output}`)));
	child.stderr?.on("data", (chunk) => {
		output += chunk;
	});
	createInterface({ input: child.stdout as NodeJS.ReadableStream }).on("line", (line) => {
		output += `${line}\n`;
		const address = /^Listening on (http:\/\/127\.0\.0\.1:\d+)\/?$/.exec(line);
		if (address) listening.resolve(address[1]);
		if (line.startsWith("Claim token: ")) token = line.slice("Claim token: ".length);
	});
	const origin = await listening.promise;
	const studio = {
		origin,
		output: () => output,
		token: () => token,
		closed,
		async stop() {
			if (child.connected) child.send("stop", () => {});
			return closed;
		},
	};
	cleanup.push(async () => {
		if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
		await closed;
	});
	return studio;
}

async function until<T>(read: () => T | Promise<T>, done: (value: T) => boolean, ms = 10_000) {
	const deadline = performance.now() + ms;
	for (;;) {
		const value = await read();
		if (done(value)) return value;
		if (performance.now() > deadline) throw new Error(`Timed out at ${String(value)}`);
		await Bun.sleep(25);
	}
}

async function signIn(studio: Studio) {
	await until(studio.token, (value) => value !== "");
	const response = await fetch(`${studio.origin}/setup`, {
		method: "POST",
		redirect: "manual",
		headers: { origin: studio.origin, accept: "text/html" },
		body: new URLSearchParams({
			token: studio.token(),
			username: "owner",
			password: crypto.randomUUID(),
		}),
	});
	expect(response.status).toBe(303);
	const cookie = response.headers
		.getSetCookie()
		.map((value) => value.split(";")[0])
		.find((value) => /^siluet_[0-9a-f-]{36}=/.test(value));
	if (!cookie) throw new Error("Missing session cookie.");
	return { cookie, origin: studio.origin };
}
type Session = Awaited<ReturnType<typeof signIn>>;

function stage(session: Session, body: BodyInit, draft: string = crypto.randomUUID()) {
	return fetch(`${session.origin}/image/files/${draft}`, {
		method: "POST",
		headers: {
			origin: session.origin,
			cookie: session.cookie,
			"content-type": "application/octet-stream",
		},
		body,
	});
}

// Seeded noise keeps the PNG above the adapter's default 512 KiB body limit.
async function largePng() {
	const raw = Buffer.alloc(768 * 256 * 3);
	let state = 17;
	for (let i = 0; i < raw.length; i++) {
		state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
		raw[i] = state >>> 24;
	}
	const png = await sharp(raw, { raw: { width: 768, height: 256, channels: 3 } })
		.png()
		.toBuffer();
	expect(png.length).toBeGreaterThan(512 * 1024);
	return png;
}

async function owner() {
	// Unicode and spaces exercise path handling on every supported OS.
	const directory = await createOwnerDirectory("Siluet café 雪 ");
	cleanup.push(() => rm(directory, { recursive: true, force: true }));
	return directory;
}

test("the built route stages a large image and keeps 512 KiB on other routes", async () => {
	const studio = await launch(await owner());
	const session = await signIn(studio);
	const png = await largePng();
	const staged = await stage(session, png);
	expect(staged.status).toBe(200);
	const descriptor = await staged.json();
	expect(descriptor).toMatchObject({ mime: "image/png", transform: "none", size: png.length });
	const preview = await fetch(
		`${session.origin}/image/files/${descriptor.draft}/${descriptor.handle}`,
		{ headers: { cookie: session.cookie } },
	);
	expect(preview.status).toBe(200);
	expect(Buffer.from(await preview.arrayBuffer()).equals(png)).toBe(true);

	// A chunked 600 KiB body to an ordinary route is refused by the server hook.
	let sent = 0;
	const chunked = new ReadableStream<Uint8Array>({
		pull(controller) {
			if (sent >= 600 * 1024) return controller.close();
			sent += 100 * 1024;
			controller.enqueue(new Uint8Array(100 * 1024));
		},
	});
	const ordinary = await fetch(`${session.origin}/image/review`, {
		method: "POST",
		headers: { origin: session.origin, cookie: session.cookie, "content-type": "application/json" },
		body: chunked,
	});
	expect(ordinary.status).toBe(413);

	// Between 16 MiB and 32,000,000 bytes the listener accepts the body and preparation refuses it.
	const between = await stage(session, new Uint8Array(17_000_000).fill(0xff));
	expect(between.status).toBe(422);
	expect(await between.json()).toMatchObject({ code: "limit" });
	// Above 32,000,000 bytes the route refuses the declared length.
	const over = await stage(session, new Uint8Array(32_000_001));
	expect(over.status).toBe(413);
	// The listener stays usable for the next file.
	expect((await stage(session, png)).status).toBe(200);
	expect(await studio.stop()).toBe(0);
	expect(studio.output()).not.toContain(descriptor.handle);
}, 60_000);

test("sign-out retires an open preview and removes its scratch file", async () => {
	const directory = await owner();
	const studio = await launch(directory);
	const session = await signIn(studio);
	const staged = await (await stage(session, await largePng())).json();
	const preview = await fetch(`${session.origin}/image/files/${staged.draft}/${staged.handle}`, {
		headers: { cookie: session.cookie },
	});
	const reader = preview.body?.getReader();
	if (!reader) throw new Error("Missing preview body.");
	expect((await reader.read()).done).toBe(false);
	const scratch = join(directory, "scratch", "image");
	expect(await readdir(scratch)).toEqual([staged.handle]);
	const signOut = await fetch(`${session.origin}/?/signout`, {
		method: "POST",
		redirect: "manual",
		headers: {
			origin: session.origin,
			cookie: session.cookie,
			"content-type": "application/x-www-form-urlencoded",
		},
		body: "",
	});
	expect(signOut.status).toBeLessThan(400);
	// Windows can delete the file only after the open preview handle closes.
	await until(
		() => readdir(scratch),
		(names) => names.length === 0,
	);
	// Drain whatever the socket already buffered. The server closed its file handle.
	try {
		while (!(await reader.read()).done);
	} catch {}
	const after = await fetch(`${session.origin}/image/files/${staged.draft}/${staged.handle}`, {
		headers: { cookie: session.cookie },
		redirect: "manual",
	});
	expect(after.status).not.toBe(200);
	expect(await studio.stop()).toBe(0);
}, 60_000);

test("shutdown mid-preparation drains, then exits, and restart reclaims scratch", async () => {
	const directory = await owner();
	const first = await launch(directory);
	const session = await signIn(first);
	const started = Promise.withResolvers<void>();
	const stalled = new ReadableStream<Uint8Array>({
		start(controller) {
			controller.enqueue(new Uint8Array([0x89, 0x50, 0x4e, 0x47]));
			started.resolve();
		},
	});
	const pending = stage(session, stalled).then(async (response) => ({
		status: response.status,
		body: await response.json(),
		at: performance.now(),
	}));
	await started.promise;
	// A second preparation is refused while the stalled body holds the slot.
	await Bun.sleep(200);
	const busy = await stage(session, await largePng());
	expect(busy.status).toBe(422);
	expect(await busy.json()).toMatchObject({ code: "busy" });
	const stopping = performance.now();
	const stopped = first.stop();
	// The launcher cancels the preparation before the adapter starts draining.
	const cancelled = await pending;
	expect(cancelled).toMatchObject({ status: 422, body: { code: "cancelled" } });
	expect(cancelled.at - stopping).toBeLessThan(2_000);
	// The adapter then waits for the stalled upload socket, bounded by Bun's idle
	// timeout and its own 30-second shutdown limit.
	expect(await stopped).toBe(0);
	expect(performance.now() - stopping).toBeLessThan(31_000);

	// Leave a copy from an interrupted process. The next runtime reclaims it under its lock.
	const leftover = join(directory, "scratch", "image");
	await mkdir(leftover, { recursive: true });
	await writeFile(join(leftover, crypto.randomUUID()), "interrupted copy");
	const second = await launch(directory);
	await until(
		async () => readdir(join(directory, "scratch", "image")).catch(() => ["missing"]),
		(names) => names.length === 0,
	);
	expect(await second.stop()).toBe(0);
}, 60_000);
