import { afterAll, beforeAll, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { rm } from "node:fs/promises";
import { connect } from "node:net";
import { sql } from "drizzle-orm";
import { providerStore } from "#lib/server/db/provider-store.ts";
import {
	openRuntimeInstallation,
	type RuntimeInstallation,
} from "#lib/server/db/runtime-installation.ts";
import { saveIntentStore } from "#lib/server/db/save-intent.ts";
import { createGallery } from "#lib/server/services/gallery/gallery.ts";
import { galleryStorage } from "#lib/server/services/gallery/storage.ts";
import { serverEnvPrefix, serverOptions } from "../../../../../scripts/server-options";
import { createOwnerDirectory } from "../../../../../tests/fixtures/owner-directory";
import { GET, HEAD } from "./+server";

// The route on a server built from the Studio's own Bun.serve options (scripts/server-options.ts),
// with the owner's idle-timeout override applied as the Bun adapter applies it.
const MiB = 1024 * 1024;
const jobId = "6b0e3f4a-3c2d-4e5f-8a9b-0c1d2e3f4a5b";
const bytes = Buffer.alloc(80 * MiB, 0x5a);
const digest = createHash("sha256").update(bytes).digest("hex");
let directory: string;
let installation: RuntimeInstallation;
let server: ReturnType<typeof Bun.serve>;
let opened: number[] = [];
let released: number[] = [];

beforeAll(async () => {
	directory = await createOwnerDirectory();
	installation = await openRuntimeInstallation(directory);
	await providerStore(installation).save("poyo", "fixture-key", Date.now(), true, 0);
	await installation.use((db) =>
		db.run(sql`INSERT INTO image_job
			(id,binding,provider,revision,quote,state,model,created_at,poll_deadline,save_due)
			VALUES (${jobId},${jobId},'poyo',1,'{}','completed','seedream-5.5',0,120000,0)`),
	);
	const token = crypto.randomUUID();
	await saveIntentStore(installation).claim(jobId, token, Date.now());
	const info = { mime: "image/png", width: 1, height: 1 } as const;
	expect(await galleryStorage(installation).publish(jobId, token, bytes, info)).toBe("saved");
	const gallery = createGallery(installation);
	const observed = {
		...gallery,
		async openImage(id: string, signal: AbortSignal) {
			const image = await gallery.openImage(id, signal);
			if (image) {
				opened.push(performance.now());
				const release = image.release;
				image.release = () => {
					released.push(performance.now());
					release();
				};
			}
			return image;
		},
	};
	const idle = process.env[`${serverEnvPrefix}CONNECTION_IDLE_TIMEOUT`];
	server = Bun.serve({
		...serverOptions,
		port: 0,
		...(idle !== undefined && { idleTimeout: Number(idle) }),
		fetch: (request) => {
			const event = {
				locals: { studio: { origin: new URL(server.url), gallery: observed } },
				params: { jobId },
				url: new URL(request.url),
				request,
			};
			return (request.method === "HEAD" ? HEAD : GET)(event as never);
		},
	});
}, 60_000);
afterAll(async () => {
	await server?.stop(true);
	await installation?.close();
	await rm(directory, { recursive: true, force: true });
}, 60_000);

test("the Studio keeps Bun's own idle timeout", () => {
	expect(serverOptions).toEqual({ hostname: "127.0.0.1" });
	expect("idleTimeout" in serverOptions).toBe(false);
});

test("GET streams the saved image under its X-Siluet-Length, and HEAD sends its headers alone", async () => {
	opened = [];
	released = [];
	const answer = await fetch(new URL(`/gallery/${jobId}/media`, server.url));
	expect(answer.status).toBe(200);
	expect(answer.headers.get("x-siluet-length")).toBe(String(bytes.length));
	const body = Buffer.from(await answer.arrayBuffer());
	expect(createHash("sha256").update(body).digest("hex")).toBe(digest);
	expect([opened.length, released.length]).toEqual([1, 1]);
	const head = await fetch(new URL(`/gallery/${jobId}/media?download=1`, server.url), {
		method: "HEAD",
	});
	expect(head.headers.get("content-length")).toBe(String(bytes.length));
	expect(head.headers.has("x-siluet-length")).toBe(false);
	expect(head.headers.get("content-disposition")).toStartWith("attachment;");
	expect(opened.length).toBe(1);
}, 60_000);

test("a paused client holds its permit while stalled, and the idle timeout releases it", async () => {
	opened = [];
	released = [];
	const port = Number(server.port);
	const socket = connect({ host: "127.0.0.1", port });
	await new Promise<void>((resolve) => socket.once("connect", () => resolve()));
	socket.pause();
	socket.write(`GET /gallery/${jobId}/media HTTP/1.1\r\nHost: 127.0.0.1:${port}\r\n\r\n`);
	try {
		for (let i = 0; i < 400 && !opened.length; i++) await Bun.sleep(5);
		expect(opened).toHaveLength(1);
		await Bun.sleep(8_000);
		// Bun has written only what the socket takes before backpressure; the permit is held.
		expect(released).toEqual([]);
		for (let i = 0; i < 240 && !released.length; i++) await Bun.sleep(50);
		expect(released).toHaveLength(1);
		const held = released[0] - opened[0];
		expect(held).toBeGreaterThan(8_000);
		expect(held).toBeLessThan(20_000);
	} finally {
		socket.destroy();
	}
}, 60_000);
