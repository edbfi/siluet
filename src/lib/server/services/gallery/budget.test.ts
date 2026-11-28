import { afterAll, beforeAll, expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
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
let bounds: GalleryBounds<"current">;

beforeAll(async () => {
	bounds = await generateGalleryBounds(["current"]);
}, 60_000);
afterAll(() => bounds?.remove(), 60_000);

// Linux carries a spawning process's peak RSS into a child spawned straight from it, so this
// test's own fixture generation would count as the scenario's. A shell that forks (it runs
// `exit` last, so it cannot exec in place) starts the harness from a small process instead; the
// harness's calibration fails the run if a peak is inherited all the same.
const isolated = ["sh", "-c", '"$@"; exit $?', "sh"];

async function measure(scenario: string, paths: string[], env: Record<string, string> = {}) {
	const child = Bun.spawn([...isolated, process.execPath, harness, scenario, ...paths], {
		env: { ...process.env, GITHUB_STEP_SUMMARY: "", ...env },
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
		files: 1,
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
	expect(await readFile(summary, "utf8")).toContain(text);
}, 60_000);

test("an unknown scenario fails before measuring", async () => {
	await expect(measure("unknown", [bounds.files.current.path])).rejects.toThrow("Unknown scenario");
}, 60_000);
