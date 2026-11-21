import { expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import bundled from "../../pricing/v1/feed.json";
import { decodePricingFeed } from "../../src/lib/shared/pricing/feed.ts";

const relativeFeed = "pricing/v1/feed.json";
const relativeLicense = "pricing/v1/LICENSE.poyo";
const script = resolve(import.meta.dir, "publish.sh");
const license = resolve(import.meta.dir, "../../", relativeLicense);
const ref = "refs/heads/pricing-data";
const sourceDateAfter = (seconds: number) =>
	new Date(Date.parse(bundled.sourceDate) + seconds * 1000).toISOString().replace(".000Z", "Z");

test("bundles a complete snapshot accepted by the shared feed decoder", () => {
	expect(JSON.stringify(decodePricingFeed(bundled))).toBe(JSON.stringify(bundled));
});

test("publishes a data-only branch atomically and makes an unchanged rerun a no-op", () => {
	const sandbox = mkdtempSync(resolve(tmpdir(), "siluet-pricing-"));
	try {
		const remote = resolve(sandbox, "remote");
		const local = resolve(sandbox, "local");
		function run(command: string[], cwd = sandbox) {
			return Bun.spawnSync(command, {
				cwd,
				env: { PATH: process.env.PATH, HOME: sandbox },
				stdout: "pipe",
				stderr: "pipe",
			});
		}
		function git(cwd: string, ...args: string[]) {
			const result = run(["git", ...args], cwd);
			if (!result.success) throw new Error(result.stderr.toString());
			return result.stdout.toString();
		}
		function publish(value: unknown, licensePath = license) {
			return Bun.spawnSync(["bash", script, "poyo", licensePath], {
				cwd: local,
				env: { PATH: process.env.PATH, HOME: sandbox },
				stdin: new TextEncoder().encode(JSON.stringify(value)),
				stdout: "pipe",
				stderr: "pipe",
			});
		}

		git(sandbox, "init", "--bare", remote);
		git(sandbox, "init", "--bare", local);
		git(local, "remote", "add", "origin", remote);

		const invalidRates = [
			null,
			{ kind: "per-request", credits: 2 },
			{ kind: "per-request", credits: "0" },
			{ kind: "per-request", credits: "-1" },
			{ kind: "per-request", credits: "1234567890123" },
			{ kind: "per-request", credits: "0.0000001" },
		];
		for (const rate of invalidRates) {
			expect(publish({ ...bundled, rates: { ...bundled.rates, "z-image": rate } }).success).toBe(
				false,
			);
		}
		const referenceRate = bundled.rates["seedream-5.5"];
		const invalidReferenceRate = {
			...referenceRate,
			resolutions: { ...referenceRate.resolutions, "2K": null },
		};
		expect(
			publish({ ...bundled, rates: { ...bundled.rates, "seedream-5.5": invalidReferenceRate } })
				.success,
		).toBe(false);
		expect(publish({ ...bundled, sourceDate: "2026-02-30T00:00:00Z" }).success).toBe(false);
		expect(git(remote, "for-each-ref", "--format=%(refname)")).toBe("");

		expect(publish(bundled).exitCode).toBe(0);
		const first = git(remote, "rev-parse", ref).trim();
		expect(git(remote, "ls-tree", "-r", "--name-only", ref)).toBe(
			`${relativeLicense}\n${relativeFeed}\n`,
		);
		expect(git(remote, "show", `${ref}:${relativeLicense}`)).toBe(
			new TextDecoder("utf-8", { ignoreBOM: true }).decode(readFileSync(license)),
		);
		expect(JSON.parse(git(remote, "show", `${ref}:${relativeFeed}`))).toEqual(bundled);
		expect(git(remote, "rev-list", "--count", ref).trim()).toBe("1");
		expect(publish(bundled).exitCode).toBe(0);
		expect(git(remote, "rev-parse", ref).trim()).toBe(first);

		const newer = {
			...bundled,
			revision: "abcdef0123456789abcdef0123456789abcdef01",
			sourceDate: sourceDateAfter(1),
		};
		expect(publish(newer).success).toBe(true);
		const second = git(remote, "rev-parse", ref).trim();
		expect(second).not.toBe(first);
		expect(git(remote, "rev-parse", `${ref}^`).trim()).toBe(first);
		expect(JSON.parse(git(remote, "show", `${ref}:${relativeFeed}`))).toEqual(newer);
		expect(publish(bundled).success).toBe(false);
		expect(publish({ ...newer, rates: { "z-image": { kind: "unavailable" } } }).success).toBe(
			false,
		);
		expect(publish({ ...newer, sourceDate: sourceDateAfter(2) }).success).toBe(false);
		expect(git(remote, "rev-parse", ref).trim()).toBe(second);

		const future = {
			...newer,
			revision: "aaddec0123456789abcdef0123456789abcdef01",
			sourceDate: new Date(Date.now() + 60_000).toISOString().replace(/\.\d{3}Z$/, "Z"),
		};
		expect(publish(future).stderr.toString()).toContain("future");
		expect(git(remote, "rev-parse", ref).trim()).toBe(second);

		const gapRates = { ...newer.rates, "z-image": { kind: "unavailable" } };
		expect(publish({ ...newer, rates: gapRates }).success).toBe(false);
		expect(git(remote, "rev-parse", ref).trim()).toBe(second);
		const gap = {
			...newer,
			revision: "fedcba0123456789abcdef0123456789abcdef01",
			sourceDate: sourceDateAfter(2),
			rates: gapRates,
		};
		const reviewedLicense = resolve(sandbox, "reviewed-license");
		const revisedNotice = "Synthetic revised upstream notice\n";
		writeFileSync(reviewedLicense, revisedNotice);
		expect(publish(newer, reviewedLicense).success).toBe(false);
		expect(publish(gap, reviewedLicense).success).toBe(true);
		expect(git(remote, "show", `${ref}:${relativeLicense}`)).toBe(revisedNotice);
		expect(git(remote, "show", `${ref}^:${relativeLicense}`)).toBe(
			git(remote, "show", `${first}:${relativeLicense}`),
		);
		expect(JSON.parse(git(remote, "show", `${ref}:${relativeFeed}`))).toEqual(gap);
		expect(git(remote, "rev-parse", `${ref}^`).trim()).toBe(second);
		const gapHead = git(remote, "rev-parse", ref).trim();
		const restored = { ...gap, rates: newer.rates };
		const changesOtherRate = {
			...restored,
			rates: { ...restored.rates, "seedream-5.5": { kind: "unavailable" } },
		};
		expect(publish(changesOtherRate, reviewedLicense).success).toBe(false);
		const changesKnownCredits = {
			...restored,
			rates: {
				...restored.rates,
				"seedream-5.5": { ...restored.rates["seedream-5.5"], perReference: "3" },
			},
		};
		expect(publish(changesKnownCredits, reviewedLicense).success).toBe(false);
		expect(publish(restored).success).toBe(false);
		expect(git(remote, "rev-parse", ref).trim()).toBe(gapHead);
		expect(publish(restored, reviewedLicense).success).toBe(true);
		expect(JSON.parse(git(remote, "show", `${ref}:${relativeFeed}`))).toEqual(restored);
		expect(git(remote, "rev-parse", `${ref}^`).trim()).toBe(gapHead);
	} finally {
		rmSync(sandbox, { recursive: true, force: true });
	}
}, 30_000);
