// Measures one Gallery save scenario's peak memory in this fresh Bun process (D5, catalog engine
// spec "Gallery size limits"). Usage: bun scripts/gallery/measure-save.ts <scenario> <paths…>
// It takes file paths only: each file streams from disk through an injected transport into the
// production download, verification and publication, in a temporary data directory. It prints
// one JSON line, also appended to $GITHUB_STEP_SUMMARY when set, so a runner whose output is
// hidden still shows its figures. Times are recorded; only peak RSS is ever gated.
import { appendFile, mkdtemp, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { RuntimeInstallation } from "../../src/lib/server/db/runtime-installation";
import type { Transport } from "../../src/lib/server/services/gallery/download";

// The calibration runs before the database, sharp and the Gallery modules load, because their
// start-up peak would otherwise hide it; they load afterwards.
const load = async () => ({
	...(await import("drizzle-orm")),
	...(await import("../../src/lib/server/db/provider-store")),
	...(await import("../../src/lib/server/db/runtime-installation")),
	...(await import("../../src/lib/server/db/save-intent")),
	...(await import("../../src/lib/server/services/gallery/download")),
	...(await import("../../src/lib/server/services/gallery/storage")),
	...(await import("../../src/lib/server/services/gallery/verify-image")),
});
type Modules = Awaited<ReturnType<typeof load>>;

const MiB = 1024 * 1024;
export const calibrationBytes = 64 * MiB;
export const scenarios = ["save"] as const;
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

/** A transport that serves `path` for any request, as a CDN would, read from disk. */
function fileTransport(path: string, size: number): Transport {
	return {
		resolve: async () => "93.184.216.34",
		request: async () =>
			new Response(Bun.file(path).stream(), { headers: { "content-length": String(size) } }),
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
	const { size } = await stat(path);
	const id = crypto.randomUUID();
	const { downloadImage, verifyImage, UnsupportedGalleryImage, galleryStorage } = modules;
	const token = await claim(modules, installation, id);
	const bytes = await timed(stages, `${label}download`, () =>
		downloadImage("https://images.example.org/result.png", fileTransport(path, size)),
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

export async function measure(scenario: Scenario, paths: readonly string[]) {
	const calibration = calibrate();
	// Release the calibration buffer before the scenario, so it reuses those pages.
	Bun.gc(true);
	const modules = await load();
	const directory = await mkdtemp(join(tmpdir(), "siluet-measure-"));
	const installation = await modules.openRuntimeInstallation(directory);
	try {
		await modules.providerStore(installation).save("poyo", "fixture-key", Date.now(), true, 0);
		Bun.gc(true);
		const before = peak() * calibration.unit;
		const stages: Record<string, number> = {};
		const start = performance.now();
		const [path] = paths;
		if (!path) throw new Error("The save scenario takes one file.");
		const outcomes = [await save(modules, installation, path, stages)];
		stages.total = Math.round(performance.now() - start);
		const after = peak() * calibration.unit;
		return {
			scenario,
			files: paths.length,
			outcomes,
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
