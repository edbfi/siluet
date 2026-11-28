import { createHash } from "node:crypto";
import { readFile, rm } from "node:fs/promises";
import { expect, type Locator, type Page } from "@playwright/test";
import { galleryStatement } from "../../src/lib/shared/image-studio/derived-review";
import { createSeedreamDraft } from "../../src/lib/shared/image-studio/seedream";
import {
	type GalleryBounds,
	type GalleryFixture,
	generateGalleryBounds,
} from "../fixtures/gallery-bounds";
import { createOwnerDirectory } from "../fixtures/owner-directory";
import { providerFixtureKeys, startProviderFixtures } from "../fixtures/provider-connections";
import { startStudio } from "./built-studio";
import { claimOwner, ownerRequest } from "./owner-session";
import { test } from "./studio-test";

// G13's raised Gallery limits in the built app (catalog engine spec, "Gallery size limits";
// D5): 20 MP and 80 MiB images save from one transfer, reopen offline, download unchanged and
// stay within the tab's read cap. Each worker generates the fixtures into a temporary directory
// before its first test here and removes them after its last, so listing or filtering the specs
// leaves nothing behind; they are never committed, and no provider is called.

type Studio = Awaited<ReturnType<typeof startStudio>>;
const MiB = 1024 * 1024;
const fixtures = ["png20", "flux4k", "encodedBound", "over20", "verification25"] as const;
let bounds: GalleryBounds<(typeof fixtures)[number]>;
test.beforeAll(async () => {
	test.setTimeout(120_000);
	bounds = await generateGalleryBounds(fixtures);
});
test.afterAll(async () => {
	test.setTimeout(60_000);
	await bounds?.remove();
});
const bytesOf = async (fixture: GalleryFixture) => new Uint8Array(await readFile(fixture.path));
const digest = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");
/** What a download is checked by: its SHA-256 and length, against the fixture's. */
const identity = (bytes: Uint8Array) => ({ sha256: digest(bytes), size: bytes.length });
const expected = (fixture: GalleryFixture) => ({ sha256: fixture.sha256, size: fixture.size });

type Media = { bytes: Uint8Array<ArrayBuffer>; paced?: true };
/**
 * Poyo.ai's submit, status and result link for any number of jobs, each with its own image.
 * A paced body streams 1 MiB every 500 ms (2 MiB/s), under Bun.serve's 10 s idle timeout.
 */
function galleryProvider() {
	const media = new Map<string, Media>();
	let next: Media | undefined;
	let count = 0;
	const fixtures = startProviderFixtures(async (request, path) => {
		if (path === "/poyo/submit" && request.method === "POST") {
			const id = `poyo-g13-${++count}`;
			if (!next) throw new Error("No image is set for the next job.");
			media.set(id, next);
			return Response.json({ code: 200, data: { task_id: id } });
		}
		const status = path.match(/^\/poyo\/status\/(poyo-g13-\d+)$/)?.[1];
		if (status)
			return Response.json({
				code: 200,
				data: {
					task_id: status,
					status: "finished",
					credits_amount: 7,
					files: [
						{
							file_type: "image",
							file_url: `https://93.184.216.34/result/image?job=${status}&expires=fixture-token`,
						},
					],
				},
			});
		if (path === "/media/image") {
			const image = media.get(new URL(request.url).searchParams.get("job") ?? "");
			if (!image) return new Response(null, { status: 404 });
			const headers = { "content-type": "image/png", "content-length": String(image.bytes.length) };
			if (!image.paced) return new Response(image.bytes, { headers });
			let offset = 0;
			const body = new ReadableStream<Uint8Array>({
				async pull(controller) {
					if (offset >= image.bytes.length) return controller.close();
					if (offset) await Bun.sleep(500);
					controller.enqueue(image.bytes.subarray(offset, offset + MiB));
					offset += MiB;
				},
			});
			return new Response(body, { headers });
		}
		return null;
	});
	return {
		fixtures,
		/** The image the next submitted job delivers. */
		deliver(image: Media) {
			next = image;
		},
		transfers: () => fixtures.requests.filter((row) => row.path === "/media/image").length,
	};
}

/** A Studio with the provider connected and every outbound browser request aborted. */
async function openStudio(page: Page, provider: ReturnType<typeof galleryProvider>) {
	const dir = await createOwnerDirectory();
	const server = await startStudio(dir, "0", false, provider.fixtures.env);
	const origin = server.origin.origin;
	const outbound: string[] = [];
	await page.route(/^https?:/, (route) => {
		if (new URL(route.request().url()).origin === origin) return route.fallback();
		outbound.push(new URL(route.request().url()).hostname);
		return route.abort();
	});
	await expect.poll(server.token).not.toBe("");
	await claimOwner(page, server, crypto.randomUUID());
	const connected = await ownerRequest(page).post(`${origin}/settings/providers?/connect`, {
		headers: { origin, accept: "text/html" },
		form: { provider: "poyo", key: providerFixtureKeys.poyo },
	});
	expect(connected.ok()).toBe(true);
	return { dir, server, origin, outbound };
}

/** Queue one Seedream request through Review, as the composer would, and return its job ID. */
async function queueSeedream(page: Page, origin: string) {
	const input = {
		draft: { ...createSeedreamDraft("poyo"), prompt: "A lighthouse in heavy fog." },
		count: 1,
		retryLimit: 0,
		acceptUnknown: false,
	};
	const post = (path: string, data: unknown) =>
		ownerRequest(page).post(origin + path, { data, headers: { origin } });
	const review = await (await post("/image/review", input)).json();
	const queued = await post("/image/queue", {
		...input,
		token: review.token,
		acceptUnknown: review.requiresConsent,
	});
	expect(queued.ok()).toBe(true);
	return ((await queued.json()) as { jobId: string }).jobId;
}

/** Queue a derived row from the composer at `resolution`, checking Review's Gallery statement. */
async function queueDerived(page: Page, origin: string, model: string, resolution: string) {
	await page.goto(`${origin}/image`);
	await page.getByLabel("Model", { exact: true }).selectOption(model);
	await page.getByRole("textbox", { name: "Prompt", exact: true }).fill("A glacier at noon.");
	await page.getByLabel("Resolution", { exact: true }).selectOption(resolution);
	const review = page.getByRole("region", { name: "Review request" });
	await review.getByRole("button", { name: "Review request" }).click();
	// No request bounds a derived row's output, so Review states Gallery's 20 MP limit.
	await expect(review.getByText(galleryStatement)).toBeVisible();
	await review.getByLabel("I accept the unknown cost of this request.").check();
	await review.getByRole("button", { name: "Queue 1 request" }).click();
	await expect(page).toHaveURL(/\/jobs/);
	const open = page.getByRole("article").getByRole("link", { name: "Open saved image" });
	await expect(open).toBeVisible({ timeout: 60_000 });
	return ((await open.getAttribute("href")) ?? "").split("/").at(-1) ?? "";
}

/** Wait until Jobs shows `jobId`'s library state. */
async function library(page: Page, origin: string, jobId: string, text: string, timeout: number) {
	await page.goto(`${origin}/jobs`);
	await expect(page.locator(`#job-${jobId}-library`)).toHaveText(text, { timeout });
}

async function download(page: Page, link: Locator) {
	const [file] = await Promise.all([page.waitForEvent("download"), link.press("Enter")]);
	return identity(await readFile(await file.path()));
}

/** Restart the Studio with the provider stopped, so only Siluet's own data remains. */
async function restartOffline(
	studio: { dir: string; server: Studio },
	provider: ReturnType<typeof galleryProvider>,
) {
	await provider.fixtures.stop();
	const port = studio.server.origin.port;
	await studio.server.stop();
	studio.server = await startStudio(studio.dir, port, false, provider.fixtures.env);
}

async function cleanup(
	studio: { dir: string; server?: Studio } | undefined,
	provider: ReturnType<typeof galleryProvider>,
) {
	await studio?.server?.stop();
	await provider.fixtures.stop();
	if (studio) await rm(studio.dir, { recursive: true, force: true });
}

test("a 20 MP PNG from nano-banana-pro 4K saves under Review's statement, reopens offline and downloads unchanged", async ({
	page,
}) => {
	test.setTimeout(240_000);
	page.setDefaultTimeout(30_000);
	const { png20 } = bounds.files;
	const provider = galleryProvider();
	provider.deliver({ bytes: await bytesOf(png20) });
	let studio: Awaited<ReturnType<typeof openStudio>> | undefined;
	try {
		studio = await openStudio(page, provider);
		const { origin } = studio;
		const jobId = await queueDerived(page, origin, "nano-banana-pro", "4K");
		const short = jobId.slice(0, 8);
		expect(provider.transfers()).toBe(1);
		await restartOffline(studio, provider);

		const href = `/gallery/${jobId}`;
		// The streamed GET declares its verified length as X-Siluet-Length (journey 7).
		const shown = page.waitForResponse(
			(response) => new URL(response.url()).pathname === `${href}/media`,
		);
		await page.goto(origin + href);
		expect((await shown).headers()["x-siluet-length"]).toBe(String(png20.size));
		await expect(page.getByText("PNG · 5000 × 4000")).toBeVisible();
		const image = page.getByRole("img", { name: `Saved image from job ${short}` });
		await expect
			.poll(() => image.evaluate((element: HTMLImageElement) => element.naturalWidth))
			.toBe(5000);
		const viewer = page.getByRole("link", { name: "Download image", exact: true });
		expect(await download(page, viewer)).toEqual(expected(png20));
		await page.goto(`${origin}/gallery`);
		const tile = page.getByRole("link", { name: `Download image ${short}` });
		expect(await download(page, tile)).toEqual(expected(png20));
		expect(studio.outbound).toEqual([]);
	} finally {
		await cleanup(studio, provider);
	}
});

test("flux-3-klein's 4K tier saves a 4096 × 4096 image and downloads it unchanged", async ({
	page,
}) => {
	test.setTimeout(180_000);
	page.setDefaultTimeout(30_000);
	const { flux4k } = bounds.files;
	const provider = galleryProvider();
	provider.deliver({ bytes: await bytesOf(flux4k) });
	let studio: Awaited<ReturnType<typeof openStudio>> | undefined;
	try {
		studio = await openStudio(page, provider);
		const jobId = await queueDerived(page, studio.origin, "flux-3-klein", "4K");
		await page.goto(`${studio.origin}/gallery/${jobId}`);
		await expect(page.getByText("PNG · 4096 × 4096")).toBeVisible();
		const viewer = page.getByRole("link", { name: "Download image", exact: true });
		expect(await download(page, viewer)).toEqual(expected(flux4k));
		expect(provider.transfers()).toBe(1);
	} finally {
		await cleanup(studio, provider);
	}
});

test("an image of exactly 80 MiB saves, reopens offline and downloads unchanged", async ({
	page,
}) => {
	test.setTimeout(180_000);
	page.setDefaultTimeout(30_000);
	const { encodedBound } = bounds.files;
	expect(encodedBound.size).toBe(80 * MiB);
	const provider = galleryProvider();
	provider.deliver({ bytes: await bytesOf(encodedBound) });
	let studio: Awaited<ReturnType<typeof openStudio>> | undefined;
	try {
		studio = await openStudio(page, provider);
		const jobId = await queueSeedream(page, studio.origin);
		await library(page, studio.origin, jobId, "Saved", 60_000);
		await restartOffline(studio, provider);
		await page.goto(`${studio.origin}/gallery/${jobId}`);
		await expect(page.getByText("PNG · 1000 × 1000")).toBeVisible();
		const viewer = page.getByRole("link", { name: "Download image", exact: true });
		expect(await download(page, viewer)).toEqual(expected(encodedBound));
		expect(provider.transfers()).toBe(1);
	} finally {
		await cleanup(studio, provider);
	}
});

test("an 80 MiB image arriving at 2 MiB/s, past the old 30 s deadline, saves from one transfer", async ({
	page,
}) => {
	test.setTimeout(240_000);
	page.setDefaultTimeout(30_000);
	const { encodedBound } = bounds.files;
	const provider = galleryProvider();
	provider.deliver({ bytes: await bytesOf(encodedBound), paced: true });
	let studio: Awaited<ReturnType<typeof openStudio>> | undefined;
	try {
		studio = await openStudio(page, provider);
		const started = performance.now();
		const jobId = await queueSeedream(page, studio.origin);
		await library(page, studio.origin, jobId, "Saved", 120_000);
		expect(performance.now() - started).toBeGreaterThan(30_000);
		expect(provider.transfers()).toBe(1);
		await page.goto(`${studio.origin}/gallery/${jobId}`);
		const viewer = page.getByRole("link", { name: "Download image", exact: true });
		expect(await download(page, viewer)).toEqual(expected(encodedBound));
	} finally {
		await cleanup(studio, provider);
	}
});

/**
 * Count, in the page, the bytes the tab holds as object URLs and the bytes `/media` reads have
 * received but not yet turned into a blob; keep the peak. A read the tab has not started taking
 * holds no bytes, so the wrapper reads only when the page does.
 */
function watchReads() {
	const state = { held: new Map<string, number>(), streaming: 0, peak: 0 };
	Object.assign(window, { __reads: state });
	const measure = () => {
		const held = [...state.held.values()].reduce((sum, size) => sum + size, 0);
		state.peak = Math.max(state.peak, held + state.streaming);
	};
	const create = URL.createObjectURL.bind(URL);
	const revoke = URL.revokeObjectURL.bind(URL);
	URL.createObjectURL = (object: Blob | MediaSource) => {
		const url = create(object);
		if (object instanceof Blob) state.held.set(url, object.size);
		measure();
		return url;
	};
	URL.revokeObjectURL = (url: string) => {
		state.held.delete(url);
		revoke(url);
	};
	const read = window.fetch.bind(window);
	window.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
		const response = await read(input, init);
		const url = new URL(input instanceof Request ? input.url : String(input), location.href);
		if (!url.pathname.endsWith("/media") || !response.body) return response;
		let received = 0;
		const end = () => {
			state.streaming -= received;
			received = 0;
		};
		const reader = response.body.getReader();
		const body = new ReadableStream<Uint8Array>(
			{
				async pull(controller) {
					const { done, value } = await reader.read();
					if (done) {
						end();
						controller.close();
						return;
					}
					received += value.byteLength;
					state.streaming += value.byteLength;
					measure();
					controller.enqueue(value);
				},
				cancel(reason) {
					end();
					return reader.cancel(reason);
				},
			},
			{ highWaterMark: 0 },
		);
		return new Response(body, { status: response.status, headers: response.headers });
	}) as typeof fetch;
}

/**
 * Linux Chromium only: the peak resident memory of each browser process this worker launched,
 * read from `/proc` and recorded, never gated.
 */
async function recordBrowserMemory() {
	if (process.platform !== "linux") return null;
	const children = async (parent: number): Promise<number[]> => {
		const listed = await readFile(`/proc/${parent}/task/${parent}/children`, "utf8").catch(
			() => "",
		);
		const direct = listed.split(/\s+/).filter(Boolean).map(Number);
		return [...direct, ...(await Promise.all(direct.map(children))).flat()];
	};
	const peaks: number[] = [];
	for (const child of await children(process.pid)) {
		const name = await readFile(`/proc/${child}/comm`, "utf8").catch(() => "");
		if (!/chrom|headless/i.test(name)) continue;
		const status = await readFile(`/proc/${child}/status`, "utf8").catch(() => "");
		const kib = status.match(/^VmHWM:\s+(\d+) kB$/m)?.[1];
		if (kib) peaks.push(Math.ceil(Number(kib) / 1024));
	}
	return peaks.sort((a, b) => b - a);
}

test("on /gallery, four 80 MiB images stay within the tab's read cap, and a third download waits for its share", async ({
	page,
	browserName,
}) => {
	test.setTimeout(300_000);
	page.setDefaultTimeout(30_000);
	const { encodedBound } = bounds.files;
	const bytes = await bytesOf(encodedBound);
	const provider = galleryProvider();
	let studio: Awaited<ReturnType<typeof openStudio>> | undefined;
	try {
		studio = await openStudio(page, provider);
		const { origin } = studio;
		const jobs: string[] = [];
		for (let i = 0; i < 4; i++) {
			provider.deliver({ bytes });
			const jobId = await queueSeedream(page, origin);
			await library(page, origin, jobId, "Saved", 60_000);
			jobs.push(jobId);
		}

		// (a) Eviction: 320 MiB of tiles against the cap read from the built page.
		await page.addInitScript(watchReads);
		await page.goto(`${origin}/gallery`);
		const cap = Number(await page.locator("[data-read-cap]").getAttribute("data-read-cap"));
		expect(cap).toBe(240 * MiB);
		const tiles = page.getByRole("list", { name: "Saved media" }).locator("img");
		await expect(tiles).toHaveCount(4);
		const blobs = () =>
			tiles.evaluateAll(
				(images: HTMLImageElement[]) =>
					images.filter((image) => image.src.startsWith("blob:")).length,
			);
		const reads = () =>
			page.evaluate(() => {
				const { held, streaming, peak } = (
					window as unknown as {
						__reads: { held: Map<string, number>; streaming: number; peak: number };
					}
				).__reads;
				return { held: [...held.values()].length, streaming, peak };
			});
		// All four were read; the least recently visible gave way, so three are held.
		await expect.poll(blobs, { timeout: 60_000 }).toBe(3);
		await expect.poll(async () => (await reads()).streaming).toBe(0);
		const after = await reads();
		expect(after.held).toBe(3);
		expect(after.peak).toBeLessThanOrEqual(cap);
		if (browserName === "chromium")
			test.info().annotations.push({
				type: "VmHWM MiB (largest first)",
				description: JSON.stringify(await recordBrowserMemory()),
			});

		// (b) The download share. Tiles and downloads read the same URL, so every tile read fails
		// first and its tile unmounts; only then do reads hold, and only later requests count.
		await page.clock.install();
		let mode: "fail" | "hold" = "fail";
		const held: { path: string; release: () => void }[] = [];
		await page.route(
			(url) => url.pathname.endsWith("/media"),
			async (route) => {
				if (mode === "fail") return route.abort();
				const { promise, resolve } = Promise.withResolvers<void>();
				held.push({ path: new URL(route.request().url()).pathname, release: resolve });
				await promise;
				return route.fallback();
			},
		);
		await page.goto(`${origin}/gallery`);
		await expect(page.getByText("File unavailable")).toHaveCount(4);
		mode = "hold";
		const links = jobs
			.slice(0, 3)
			.map((jobId) => page.getByRole("link", { name: `Download image ${jobId.slice(0, 8)}` }));
		const first = page.waitForEvent("download");
		for (const link of links) await link.click();
		await expect.poll(() => held.length).toBe(2);
		await expect(links[2]).toHaveAttribute("aria-busy", "true");
		await expect(page.getByText("Preparing download…")).toHaveCount(3);
		await page.waitForTimeout(1_000);
		expect(held.map(({ path }) => path)).toEqual([0, 1].map((i) => `/gallery/${jobs[i]}/media`));
		held[0]?.release();
		expect(identity(await readFile(await (await first).path()))).toEqual(expected(encodedBound));
		await expect(links[0]).not.toHaveAttribute("aria-busy");
		// Download 1's link still pins its 80 MiB until it is revoked a minute after the click.
		await page.waitForTimeout(1_000);
		expect(held).toHaveLength(2);
		await page.clock.fastForward(60_001);
		await expect.poll(() => held.length).toBe(3);
		expect(held[2]?.path).toBe(`/gallery/${jobs[2]}/media`);
		for (const read of held) read.release();
		expect(studio.outbound).toEqual([]);
	} finally {
		await cleanup(studio, provider);
	}
});

test("complete images over 20 MP, up to 25 MP, are held as unsupported, never as Download failed", async ({
	page,
}) => {
	test.setTimeout(180_000);
	page.setDefaultTimeout(30_000);
	const provider = galleryProvider();
	let studio: Awaited<ReturnType<typeof openStudio>> | undefined;
	try {
		studio = await openStudio(page, provider);
		for (const fixture of [bounds.files.over20, bounds.files.verification25]) {
			provider.deliver({ bytes: await bytesOf(fixture) });
			const jobId = await queueSeedream(page, studio.origin);
			await library(
				page,
				studio.origin,
				jobId,
				"Not saved · this image is outside the Gallery profile",
				60_000,
			);
		}
		await expect(page.getByText("Download failed")).toHaveCount(0);
		// Each was read once and classified, not retried as a failed download.
		expect(provider.transfers()).toBe(2);
	} finally {
		await cleanup(studio, provider);
	}
});
