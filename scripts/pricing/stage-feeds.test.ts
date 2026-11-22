import { afterEach, beforeEach, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";

const script = resolve(import.meta.dir, "stage-feeds.sh");
const specs = [
	"pricing-data:pricing/v2/poyo.json:poyo-v2.json",
	"pricing-data:pricing/v1/feed.json:poyo-v1.json",
	"pricing-data-toapis:pricing/v1/toapis.json:toapis.json",
	"main:pricing/v2/poyo.json:bundled-poyo.json",
];
let sandbox: string;
let remote: string;
let local: string;
let feeds: string;

function run(cwd: string, args: string[], stdin?: string) {
	const result = Bun.spawnSync(args, {
		cwd,
		env: { PATH: process.env.PATH, HOME: sandbox, GIT_INDEX_FILE: resolve(sandbox, "index") },
		stdin: stdin === undefined ? undefined : new TextEncoder().encode(stdin),
		stdout: "pipe",
		stderr: "pipe",
	});
	return { ...result, out: result.stdout.toString(), err: result.stderr.toString() };
}

function git(cwd: string, ...args: string[]) {
	const result = run(cwd, ["git", ...args]);
	if (!result.success) throw new Error(result.err);
	return result.out.trim();
}

/** Point a branch of the remote at a commit holding exactly these files. */
function branch(name: string, files: Record<string, string>) {
	rmSync(resolve(sandbox, "index"), { force: true });
	for (const [path, content] of Object.entries(files)) {
		const id = run(remote, ["git", "hash-object", "-w", "--stdin"], content).out.trim();
		git(remote, "update-index", "--add", "--cacheinfo", `100644,${id},${path}`);
	}
	const tree = git(remote, "write-tree");
	const commit = run(
		remote,
		["git", "-c", "user.name=t", "-c", "user.email=t@example.test", "commit-tree", tree],
		"seed",
	).out.trim();
	git(remote, "update-ref", `refs/heads/${name}`, commit);
}

function stage() {
	return run(local, ["bash", script, feeds, ...specs]);
}

beforeEach(() => {
	sandbox = mkdtempSync(resolve(tmpdir(), "siluet-stage-feeds-"));
	remote = resolve(sandbox, "remote");
	local = resolve(sandbox, "local");
	feeds = resolve(sandbox, "feeds");
	git(sandbox, "init", "--bare", remote);
	git(sandbox, "init", local);
	git(local, "remote", "add", "origin", remote);
});

afterEach(() => {
	rmSync(sandbox, { recursive: true, force: true });
});

test("stages every available feed when a branch or file is absent", () => {
	branch("pricing-data", { "pricing/v1/feed.json": "v1\n" });
	branch("main", { "pricing/v2/poyo.json": "bundled\n" });
	const result = stage();
	expect(result.err).toBe("");
	expect(result.exitCode).toBe(0);
	expect(result.out).toContain("pricing/v2/poyo.json does not exist on the pricing-data branch.");
	expect(result.out).toContain("The pricing-data-toapis branch does not exist.");
	expect(result.out).not.toContain("::error");
	expect(readdirSync(feeds).sort()).toEqual(["bundled-poyo.json", "poyo-v1.json"]);
	expect(readFileSync(resolve(feeds, "poyo-v1.json"), "utf8")).toBe("v1\n");
	expect(readFileSync(resolve(feeds, "bundled-poyo.json"), "utf8")).toBe("bundled\n");
});

test("stages a published v2 feed beside v1", () => {
	branch("pricing-data", { "pricing/v1/feed.json": "v1\n", "pricing/v2/poyo.json": "v2\n" });
	branch("pricing-data-toapis", { "pricing/v1/toapis.json": "toapis\n" });
	const result = stage();
	expect(result.exitCode).toBe(0);
	expect(readdirSync(feeds).sort()).toEqual(["poyo-v1.json", "poyo-v2.json", "toapis.json"]);
	expect(readFileSync(resolve(feeds, "poyo-v2.json"), "utf8")).toBe("v2\n");
});

test("reports an unreadable remote as an error, not as an absent feed", () => {
	git(local, "remote", "set-url", "origin", resolve(sandbox, "missing"));
	const result = stage();
	expect(result.exitCode).toBe(1);
	const errors = result.out.split("\n").filter((line) => line.startsWith("::error"));
	expect(errors).toEqual([
		"::error title=Pricing freshness::Could not determine whether the pricing-data branch exists.",
		"::error title=Pricing freshness::Could not determine whether the pricing-data-toapis branch exists.",
		"::error title=Pricing freshness::Could not determine whether the main branch exists.",
	]);
	expect(result.out).not.toContain("does not exist");
	expect(existsSync(feeds) ? readdirSync(feeds) : []).toEqual([]);
});
