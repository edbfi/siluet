// Measures one Gallery scenario's peak memory in this fresh Bun process (D5, catalog engine spec
// "Gallery size limits"). Usage: bun scripts/gallery/measure-save.ts <scenario> <paths…>
// It takes file paths only: each file streams from disk through an injected transport into the
// production download, verification and publication, in a temporary data directory. It prints
// one JSON line, also appended to $GITHUB_STEP_SUMMARY when set, so a runner whose output is
// hidden still shows its figures. Times are recorded; only peak RSS is ever gated.
//
// - save <file>: one download, verification and publication.
// - saves <file> <file>: two saves through the Save worker, with its two transfers and one
//   verification slot.
// - reads <file>: four concurrent Gallery reads of one saved file through the route's two read
//   permits and its streamed response.
// - combined <file> <file> <saved file> <cleanup JPEG>: the two saves, while two reads hold their
//   buffers and the D7 cleanup slot prepares the JPEG during a verification.
import { createHash } from "node:crypto";
import { appendFile, mkdtemp, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { RuntimeInstallation } from "../../src/lib/server/db/runtime-installation";
import type { Transport } from "../../src/lib/server/services/gallery/download";

// The calibration runs before the database, sharp and the Gallery modules load, because their
// start-up peak would otherwise hide it; they load afterwards.
const load = async () => ({
	...(await import("drizzle-orm")),
	sharp: (await import("sharp")).default,
	...(await import("../../src/lib/server/db/provider-store")),
	...(await import("../../src/lib/server/db/runtime-installation")),
	...(await import("../../src/lib/server/db/save-intent")),
	...(await import("../../src/lib/server/services/gallery/auto-save")),
	...(await import("../../src/lib/server/services/gallery/download")),
	...(await import("../../src/lib/server/services/gallery/gallery")),
	...(await import("../../src/lib/server/services/gallery/image-response")),
	...(await import("../../src/lib/server/services/gallery/storage")),
	...(await import("../../src/lib/server/services/gallery/verify-image")),
	...(await import("../../src/lib/server/services/media-cleanup/preparation")),
});
type Modules = Awaited<ReturnType<typeof load>>;

const MiB = 1024 * 1024;
export const calibrationBytes = 64 * MiB;
export const scenarios = ["save", "saves", "reads", "combined"] as const;
export type Scenario = (typeof scenarios)[number];

/** Peak resident set size so far, in the runtime's own unit. */
const peak = () => process.resourceUsage().maxRSS;

/**
 * Fill a 64 MiB buffer so every page is resident, and read the unit `maxRSS` reports in from
 * how far the peak moved: kibibytes, as documented, or bytes.
 */
function calibrate() {
	const before = peak();
	const buffer = new Uint8Array(calibrationBytes);
	for (let offset = 0; offset < buffer.length; offset += 4096) buffer[offset] = 1;
	const after = peak();
	const unit = after - before > calibrationBytes / 2 ? 1 : 1024;
	return { before: before * unit, after: after * unit, unit, touched: buffer.length };
}

/** A transport that serves a file for each request, as a CDN would, read from disk. */
function fileTransport(pathFor: (url: URL) => string): Transport {
	return {
		resolve: async () => "93.184.216.34",
		request: async (url) => {
			const path = pathFor(url);
			const { size } = await stat(path);
			return new Response(Bun.file(path).stream(), {
				headers: { "content-length": String(size) },
			});
		},
	};
}

/** A completed job whose save intent is claimed, as the worker would claim it. */
async function claim(
	{ sql, saveIntentStore }: Modules,
	installation: RuntimeInstallation,
	id: string,
) {
	await installation.use((db) =>
		db.run(sql`INSERT INTO image_job
			(id,binding,provider,revision,quote,state,model,created_at,poll_deadline,save_due)
			VALUES (${id},${id},'poyo',1,'{}','completed','seedream-5.5',0,120000,0)`),
	);
	const token = crypto.randomUUID();
	if (!(await saveIntentStore(installation).claim(id, token, Date.now())))
		throw new Error("The fixture job could not be claimed.");
	return token;
}

const timed = async <T>(stages: Record<string, number>, name: string, work: () => Promise<T>) => {
	const start = performance.now();
	try {
		return await work();
	} finally {
		stages[name] = Math.round(performance.now() - start);
	}
};

/** Download, verify and publish one file. Resolves with the outcome Save would record. */
async function save(
	modules: Modules,
	installation: RuntimeInstallation,
	path: string,
	stages: Record<string, number>,
	label = "",
) {
	const id = crypto.randomUUID();
	const { downloadImage, verifyImage, UnsupportedGalleryImage, galleryStorage } = modules;
	const token = await claim(modules, installation, id);
	const bytes = await timed(stages, `${label}download`, () =>
		downloadImage(
			"https://images.example.org/result.png",
			fileTransport(() => path),
		),
	);
	let info: Awaited<ReturnType<typeof verifyImage>>;
	try {
		info = await timed(stages, `${label}verify`, () => verifyImage(bytes));
	} catch (error) {
		if (error instanceof UnsupportedGalleryImage) return "unsupported";
		throw error;
	}
	return timed(stages, `${label}publish`, () =>
		galleryStorage(installation).publish(id, token, bytes, info),
	);
}

/** A completed job that is due to save, as the worker finds it after a completing read. */
async function due({ sql }: Modules, installation: RuntimeInstallation, id: string) {
	await installation.use((db) =>
		db.run(sql`INSERT INTO image_job
			(id,binding,provider,revision,quote,state,model,created_at,poll_deadline,save_due)
			VALUES (${id},${id},'poyo',1,'{}','completed','seedream-5.5',0,120000,0)`),
	);
}

/** Where Save left `id`: saved in the Gallery, held, or neither yet. */
async function outcome({ sql }: Modules, installation: RuntimeInstallation, id: string) {
	return installation.use(async (db) => {
		const saved = await db.get<{ state: string }>(
			sql`SELECT state FROM gallery_image WHERE job_id=${id}`,
		);
		if (saved) return saved.state;
		const job = await db.get<{ save_hold: string | null; save_tries: number }>(
			sql`SELECT save_hold, save_tries FROM image_job WHERE id=${id}`,
		);
		return job?.save_hold ?? (job?.save_tries ? "failed" : null);
	});
}

/** Peak counts of the stages that ran together. */
type Concurrency = Record<string, number | boolean>;
const counter = (concurrency: Concurrency, name: string) => {
	let running = 0;
	concurrency[name] = 0;
	return {
		get running() {
			return running;
		},
		/** Count one more running; the returned function, once, counts it finished. */
		enter() {
			concurrency[name] = Math.max(Number(concurrency[name]), ++running);
			let left = false;
			return () => {
				if (!left) running--;
				left = true;
			};
		},
		async around<T>(work: () => Promise<T>) {
			const leave = this.enter();
			try {
				return await work();
			} finally {
				leave();
			}
		},
	};
};

/**
 * Save each file through the production Save worker, which runs two image transfers at once and
 * verifies one at a time. `verifying` runs as each verification starts, inside the slot.
 */
async function workerSaves(
	modules: Modules,
	installation: RuntimeInstallation,
	paths: readonly string[],
	concurrency: Concurrency,
	verifying: (running: { verifications: number }) => void = () => {},
) {
	const ids = paths.map(() => crypto.randomUUID());
	const files = new Map(ids.map((id, i) => [`/${id}`, paths[i] ?? ""]));
	for (const id of ids) await due(modules, installation, id);
	const transfers = counter(concurrency, "transfers");
	const verifications = counter(concurrency, "verifications");
	const autoSave = modules.createAutoSave(installation, {
		readForSave: async () => {
			throw new Error("The harness delivers every link.");
		},
		readability: modules.providerStore(installation).jobReadability,
		transport: fileTransport((url) => files.get(url.pathname) ?? ""),
		transferImage: (url, transport, signal) =>
			transfers.around(() => modules.downloadImage(url, transport, signal)),
		verify: (bytes) =>
			verifications.around(() => {
				verifying({ verifications: verifications.running });
				return modules.verifyImage(bytes);
			}),
	});
	for (const id of ids)
		autoSave.deliver(id, { url: `https://images.example.org/${id}`, fallback: null });
	autoSave.start();
	const deadline = performance.now() + 50_000;
	let outcomes: (string | null)[] = [];
	try {
		for (;;) {
			await Bun.sleep(10);
			await autoSave.idle();
			outcomes = await Promise.all(ids.map((id) => outcome(modules, installation, id)));
			if (outcomes.every(Boolean)) return outcomes;
			if (performance.now() > deadline) throw new Error("The saves did not finish in time.");
		}
	} finally {
		await autoSave.close();
	}
}

/** Publish `path` as a saved image without decoding it, so seeding costs only its bytes. */
async function seedSaved(modules: Modules, installation: RuntimeInstallation, path: string) {
	const id = crypto.randomUUID();
	const token = await claim(modules, installation, id);
	const { format, width = 0, height = 0 } = await modules.sharp(path).metadata();
	const mimes = { png: "image/png", jpeg: "image/jpeg", webp: "image/webp" } as const;
	const mime = mimes[format as keyof typeof mimes];
	if (!mime) throw new Error("The read fixture is not a Gallery image.");
	const bytes = Buffer.from(await Bun.file(path).arrayBuffer());
	const digest = createHash("sha256").update(bytes).digest("hex");
	if (
		(await modules.galleryStorage(installation).publish(id, token, bytes, {
			mime,
			width,
			height,
		})) !== "saved"
	)
		throw new Error("The read fixture was not saved.");
	return { id, digest };
}

/** Open one saved image under a read permit, as the route's GET does. */
async function openRead(
	modules: Modules,
	gallery: ReturnType<Modules["createGallery"]>,
	id: string,
	reads: ReturnType<typeof counter>,
) {
	const image = await gallery.openImage(id, new AbortController().signal);
	if (!image) throw new Error("The saved image is unavailable.");
	// The buffer counts as held from its read until its response releases the permit.
	const leave = reads.enter();
	const release = image.release;
	image.release = () => {
		leave();
		release();
	};
	const url = new URL(`http://127.0.0.1/gallery/${id}/media`);
	return modules.imageResponse(image, url, "siluet-image.png");
}

/** Read a response body as a client would, keeping only its digest. */
async function drain(response: Response) {
	const hash = createHash("sha256");
	if (response.body) for await (const chunk of response.body) hash.update(chunk);
	return hash.digest("hex");
}

/** Prepare `path` through the D7 cleanup slot, as a staged reference upload would. */
async function prepare(modules: Modules, installation: RuntimeInstallation, path: string) {
	const prepareMedia = modules.createMediaPreparation(installation);
	const bytes = new Uint8Array(await Bun.file(path).arrayBuffer());
	return prepareMedia(bytes, new AbortController().signal, async () => "prepared");
}

type Run = { outcomes: (string | null)[]; concurrency?: Concurrency };

async function run(
	scenario: Scenario,
	modules: Modules,
	installation: RuntimeInstallation,
	paths: readonly string[],
	stages: Record<string, number>,
	setup: () => Promise<void>,
): Promise<Run> {
	const concurrency: Concurrency = {};
	if (scenario === "save") {
		const [path] = paths;
		if (!path || paths.length !== 1) throw new Error("The save scenario takes one file.");
		await setup();
		return { outcomes: [await save(modules, installation, path, stages)] };
	}
	if (scenario === "saves") {
		if (paths.length !== 2) throw new Error("The saves scenario takes two files.");
		await setup();
		const outcomes = await timed(stages, "saves", () =>
			workerSaves(modules, installation, paths, concurrency),
		);
		return { outcomes, concurrency };
	}
	const gallery = modules.createGallery(installation);
	if (scenario === "reads") {
		const [path] = paths;
		if (!path || paths.length !== 1) throw new Error("The reads scenario takes one file.");
		const saved = await seedSaved(modules, installation, path);
		await setup();
		const reads = counter(concurrency, "reads");
		const outcomes = await timed(stages, "reads", async () => {
			// All four ask at once; the permits admit them in arrival order, two at a time. Each pair
			// is drained only once both its buffers are read, so the route holds two at its peak.
			const opened = Array.from({ length: 4 }, () => openRead(modules, gallery, saved.id, reads));
			const digests: string[] = [];
			for (let pair = 0; pair < opened.length; pair += 2)
				digests.push(
					...(await Promise.all((await Promise.all(opened.slice(pair, pair + 2))).map(drain))),
				);
			return digests.map((digest) => (digest === saved.digest ? "read" : "mismatch"));
		});
		return { outcomes, concurrency };
	}
	const [first, second, readPath, cleanupPath] = paths;
	if (!first || !second || !readPath || !cleanupPath || paths.length !== 4)
		throw new Error("The combined scenario takes two saves, a saved file and a cleanup JPEG.");
	const saved = await seedSaved(modules, installation, readPath);
	await setup();
	const reads = counter(concurrency, "reads");
	// Both reads hold their buffers until the saves and the cleanup finish.
	const held = await Promise.all([0, 1].map(() => openRead(modules, gallery, saved.id, reads)));
	const cleanup = Promise.withResolvers<string>();
	let cleaning: Promise<string> | undefined;
	concurrency.overlapped = false;
	const outcomes = await timed(stages, "combined", async () => {
		const saves = workerSaves(modules, installation, [first, second], concurrency, (running) => {
			// The cleanup starts with the first verification, so their decodes overlap.
			if (cleaning) return;
			concurrency.overlapped = running.verifications === 1 && reads.running === 2;
			cleaning = timed(stages, "cleanup", () => prepare(modules, installation, cleanupPath));
			cleaning.then(cleanup.resolve, cleanup.reject);
		});
		const saveOutcomes = await saves;
		const prepared = await cleanup.promise;
		const digests = await Promise.all(held.map(drain));
		return [
			...saveOutcomes,
			...digests.map((digest) => (digest === saved.digest ? "read" : "mismatch")),
			prepared,
		];
	});
	return { outcomes, concurrency };
}

export async function measure(scenario: Scenario, paths: readonly string[]) {
	const calibration = calibrate();
	// Release the calibration buffer before the scenario, so it reuses those pages.
	Bun.gc(true);
	const modules = await load();
	const directory = await mkdtemp(join(tmpdir(), "siluet-measure-"));
	const installation = await modules.openRuntimeInstallation(directory);
	try {
		await modules.providerStore(installation).save("poyo", "fixture-key", Date.now(), true, 0);
		const stages: Record<string, number> = {};
		let before = 0;
		let start = 0;
		// Seeding a saved file happens before `before`; the peak still includes it, as it is
		// below a scenario's own.
		const setup = async () => {
			Bun.gc(true);
			before = peak() * calibration.unit;
			start = performance.now();
		};
		const { outcomes, concurrency } = await run(
			scenario,
			modules,
			installation,
			paths,
			stages,
			setup,
		);
		stages.total = Math.round(performance.now() - start);
		const after = peak() * calibration.unit;
		return {
			scenario,
			files: paths.length,
			outcomes,
			...(concurrency && { concurrency }),
			runner: { platform: process.platform, arch: process.arch, bun: Bun.version },
			calibration,
			maxRSS: { before, after },
			peakMiB: Math.ceil(after / MiB),
			stagesMs: stages,
		};
	} finally {
		await installation.close();
		await rm(directory, { recursive: true, force: true });
	}
}

if (import.meta.main) {
	const [scenario, ...paths] = Bun.argv.slice(2);
	if (!scenarios.includes(scenario as Scenario))
		throw new Error(`Unknown scenario: ${scenario ?? "none"}.`);
	const result = JSON.stringify(await measure(scenario as Scenario, paths));
	console.log(result);
	if (process.env.GITHUB_STEP_SUMMARY)
		await appendFile(process.env.GITHUB_STEP_SUMMARY, `\n\`\`\`json\n${result}\n\`\`\`\n`);
}
