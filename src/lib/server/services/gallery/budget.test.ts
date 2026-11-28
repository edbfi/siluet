import { afterAll, beforeAll, expect, test } from "bun:test";
import { appendFile, readFile } from "node:fs/promises";
import { join } from "node:path";
import {
	type GalleryBounds,
	generateGalleryBounds,
} from "../../../../../tests/fixtures/gallery-bounds";
import { rssCeilingsMiB } from "./budgets";

// Gallery's peak-memory budgets (D5): each scenario runs in a fresh Bun process through the
// production download, verification and publication, and its peak RSS must stay within its
// ceiling. Only memory is gated; the stage times are recorded for the D5 amendment.

const MiB = 1024 * 1024;
const harness = join(import.meta.dir, "../../../../../scripts/gallery/measure-save.ts");
const fixtures = [
	"current",
	"png20",
	"jpeg20",
	"webp20",
	"png16",
	"verification25",
	"encodedBound",
	"cleanupJpeg",
] as const;
let bounds: GalleryBounds<(typeof fixtures)[number]>;

beforeAll(async () => {
	bounds = await generateGalleryBounds(fixtures);
}, 60_000);
afterAll(() => bounds?.remove(), 60_000);

// Linux carries a spawning process's peak RSS into a child spawned straight from it, so this
// test's own fixture generation would count as the scenario's. A shell that forks (it runs
// `exit` last, so it cannot exec in place) starts the harness from a small process instead; the
// harness's calibration fails the run if a peak is inherited all the same.
const isolated = ["sh", "-c", '"$@"; exit $?', "sh"];

async function measure(scenario: string, paths: string[], env: Record<string, string> = {}) {
	const child = Bun.spawn([...isolated, process.execPath, harness, scenario, ...paths], {
		// In CI each run appends its figures to the job summary, where the ceilings come from.
		env: { ...process.env, ...env },
		stdout: "pipe",
		stderr: "pipe",
	});
	const [stdout, stderr, code] = await Promise.all([
		new Response(child.stdout).text(),
		new Response(child.stderr).text(),
		child.exited,
	]);
	if (code !== 0) throw new Error(`The ${scenario} scenario failed: ${stderr}`);
	return { text: stdout.trim(), result: JSON.parse(stdout) };
}

test("a save at today's bound reports its calibrated peak within the ceiling, and appends it to the job summary", async () => {
	const summary = join(bounds.directory, "summary.md");
	const { text, result } = await measure("save", [bounds.files.current.path], {
		GITHUB_STEP_SUMMARY: summary,
	});
	expect(result).toMatchObject({
		scenario: "save",
		files: ["current"],
		outcomes: ["saved"],
		runner: { platform: process.platform, arch: process.arch, bun: Bun.version },
	});
	expect(Object.keys(result.stagesMs).sort()).toEqual(["download", "publish", "total", "verify"]);
	// The 64 MiB calibration buffer is resident, so the reported unit is proven on this OS.
	const { calibration } = result;
	expect([1, 1024]).toContain(calibration.unit);
	expect(calibration.after - calibration.before).toBeGreaterThanOrEqual(32 * MiB);
	expect(calibration.after - calibration.before).toBeLessThan(128 * MiB);
	expect(result.maxRSS.after).toBeGreaterThanOrEqual(result.maxRSS.before);
	expect(result.peakMiB).toBe(Math.ceil(result.maxRSS.after / MiB));
	expect(result.peakMiB).toBeLessThanOrEqual(rssCeilingsMiB.current);
	const appended = await readFile(summary, "utf8");
	expect(appended).toContain(text);
	// This run's figures still reach the job's own summary.
	if (process.env.GITHUB_STEP_SUMMARY) await appendFile(process.env.GITHUB_STEP_SUMMARY, appended);
}, 60_000);

test("an unknown scenario fails before measuring", async () => {
	await expect(measure("unknown", [bounds.files.current.path])).rejects.toThrow("Unknown scenario");
}, 60_000);

// Each scenario at G13's bounds (catalog engine spec, "Gallery size limits"), one at a time.
test.each([
	["png20", "saved"],
	["jpeg20", "saved"],
	["webp20", "saved"],
	["png16", "saved"],
	// A complete 25 MP image is classified, then held as unsupported.
	["verification25", "unsupported"],
] as const)(
	"one save of %s stays within its ceiling",
	async (fixture, outcome) => {
		const { result } = await measure("save", [bounds.files[fixture].path]);
		expect(result.files).toEqual([fixture]);
		expect(result.outcomes).toEqual([outcome]);
		expect(result.peakMiB).toBeLessThanOrEqual(rssCeilingsMiB[fixture]);
	},
	60_000,
);

test("two saves through the worker overlap their transfers and verify one at a time within the ceiling", async () => {
	const { webp20 } = bounds.files;
	const { result } = await measure("saves", [webp20.path, webp20.path]);
	expect(result.outcomes).toEqual(["saved", "saved"]);
	// The production caps: both transfers ran together, and only one verification at a time.
	expect(result.concurrency).toEqual({ transfers: 2, verifications: 1 });
	expect(result.peakMiB).toBeLessThanOrEqual(rssCeilingsMiB.saves);
}, 60_000);

test("four Gallery reads of an 80 MiB file hold two buffers within the ceiling", async () => {
	const { encodedBound } = bounds.files;
	const { result } = await measure("reads", [encodedBound.path]);
	expect(result.outcomes).toEqual(["read", "read", "read", "read"]);
	expect(result.concurrency).toEqual({ reads: 2 });
	expect(result.peakMiB).toBeLessThanOrEqual(rssCeilingsMiB.reads);
}, 60_000);

test("two transfers, one verification, two held reads and one cleanup at once stay within the combined ceiling", async () => {
	const { webp20, encodedBound, cleanupJpeg } = bounds.files;
	const { result } = await measure("combined", [
		webp20.path,
		webp20.path,
		encodedBound.path,
		cleanupJpeg.path,
	]);
	expect(result.outcomes).toEqual(["saved", "saved", "read", "read", "prepared"]);
	// The cleanup decoded while a verification ran and both read buffers were held.
	expect(result.concurrency).toEqual({
		transfers: 2,
		verifications: 1,
		reads: 2,
		overlapped: true,
	});
	expect(result.peakMiB).toBeLessThanOrEqual(rssCeilingsMiB.combined);
}, 60_000);
