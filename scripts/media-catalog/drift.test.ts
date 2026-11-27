import { expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	type Baseline,
	committedBaseline,
	drift,
	fetchMirror,
	headRevision,
	mirrorPath,
	readMirror,
	renderReport,
	repinCheck,
	type WatchedPage,
} from "./drift";
import { projectCatalog, projectOpenApi, sha256 } from "./project";
import record from "./sources/sources.json";

// Fresh fixtures: a three-entry catalog, a docs index with two specs, two reviewed REST pages,
// one ToAPIs descriptor page, the ToAPIs model list and the ToAPIs public catalog.
const entry = (model_id: string, category: string, extra: object = {}) => ({
	model_id,
	category,
	status: "stable",
	service_type: "generate",
	execution_mode: "async",
	input_schema: {
		type: "object",
		properties: { prompt: { type: "string" }, size: { type: "string", enum: ["1:1", "16:9"] } },
	},
	billing: { type: "fixed", credits: 4 },
	...extra,
});
const items = [
	entry("fixture-image", "text2img"),
	entry("fixture-video", "video"),
	entry("fixture-edit", "img2img"),
	entry("fixture-chat", "chat"),
];
const catalogText = (list: object[]) => JSON.stringify({ has_more: false, items: list });
const index = (paths: string[]) =>
	`# Fixture\n\n## OpenAPI Specs\n\n${paths.map((path) => `- [spec](${path})`).join("\n")}\n\n## Other\n`;
const spec = (models: string[], properties: object) =>
	JSON.stringify({
		components: {
			schemas: {
				SubmitRequest: {
					type: "object",
					properties: {
						model: { type: "string", enum: models },
						input: { type: "object", properties },
					},
				},
			},
		},
	});
const pinned = "f".repeat(40);
const head = "e".repeat(40);
const pages = {
	rest: "https://docs.poyo.ai/api-manual/image-series/fixture-image.md",
	descriptor: "https://docs.toapis.com/docs/en/api-reference/images/fixture/generation.md",
	list: "https://docs.toapis.com/docs/en/api-reference/chat/list-models.md",
	catalog: "https://docs.toapis.com/docs/en/api-reference/models.md",
};
type Files = Record<string, string>;
const upstreamFiles = (): Files => ({
	revision: `${pinned}\n`,
	"capability-catalog.json": catalogText(items),
	"llms.txt": index(["/api-manual/one.json", "/api-manual/two.json"]),
	"openapi/api-manual/one.json": spec(["fixture-image", "fixture-edit"], {
		prompt: { type: "string" },
	}),
	"openapi/api-manual/two.json": spec(["fixture-video"], { prompt: { type: "string" } }),
	[mirrorPath(pages.rest)]: "# Fixture image\n\nNo prompt limit is stated.\n",
	[mirrorPath(pages.descriptor)]: "# Fixture ToAPIs image\n",
	[mirrorPath(pages.list)]: "# List Models\n",
	[mirrorPath(pages.catalog)]: "# Public Model Catalog\n\n- fixture\n",
});

/** A baseline pinned to the fixture upstream as it stands, the way a re-pin records it. */
function fixtureBaseline(files = upstreamFiles()): Baseline {
	const fixtureRecord = {
		...record,
		catalog: {
			...record.catalog,
			revision: pinned,
			upstream: record.catalog.upstream.replace(record.catalog.revision, pinned),
			upstreamSha256: sha256(files["capability-catalog.json"]),
		},
		openapi: {
			...record.openapi,
			date: "2026-01-01",
			extraIds: { ...record.openapi.extraIds, ids: [] },
			noModelSpecs: { ...record.openapi.noModelSpecs, paths: [] },
		},
	};
	const catalog = projectCatalog(files["capability-catalog.json"], pinned);
	const openapi = projectOpenApi(
		files["llms.txt"],
		(path) => files[`openapi${path}`],
		new Set(["fixture-image", "fixture-video", "fixture-edit"]),
		"2026-01-01",
		new Set(),
	);
	const watched: WatchedPage[] = [
		{ kind: "rest", url: pages.rest, sha256: sha256(files[mirrorPath(pages.rest)]), note: "q10" },
		{
			kind: "toapis-descriptor",
			url: pages.descriptor,
			sha256: sha256(files[mirrorPath(pages.descriptor)]),
			note: "fixture descriptor",
		},
		{
			kind: "toapis-model-list",
			url: pages.list,
			sha256: sha256(files[mirrorPath(pages.list)]),
			note: "model list",
		},
		{
			kind: "toapis-catalog",
			url: pages.catalog,
			sha256: sha256(files[mirrorPath(pages.catalog)]),
			note: "public catalog",
		},
	];
	return { record: fixtureRecord, catalog, openapi, pages: watched };
}
const reader = (files: Files) => (path: string) => files[path];

test("an unchanged upstream passes", () => {
	const files = upstreamFiles();
	const result = drift(fixtureBaseline(files), reader(files));
	expect(result.findings).toEqual([]);
	expect(result.notCovered).toEqual([]);
	expect(renderReport(result)).toContain("No drift");
});

test("a moved head with an unchanged catalog file passes and names the head", () => {
	const files = upstreamFiles();
	const baseline = fixtureBaseline(files);
	const result = drift(baseline, reader({ ...files, revision: `${head}\n` }));
	expect(result.findings).toEqual([]);
	expect(result.head).toBe(head);
	expect(renderReport(result)).toContain(head);
});

test("a catalog with one model added, one removed, one enum changed and one billing changed fails and lists all four", () => {
	const baseline = fixtureBaseline();
	const changed = [
		entry("fixture-image", "text2img", {
			input_schema: {
				type: "object",
				properties: {
					prompt: { type: "string" },
					size: { type: "string", enum: ["1:1", "16:9", "9:16"] },
				},
			},
		}),
		// fixture-video removed.
		entry("fixture-edit", "img2img", { billing: { type: "fixed", credits: 5 } }),
		entry("fixture-new", "text2vid"),
		entry("fixture-chat", "chat"),
	];
	const files = {
		...upstreamFiles(),
		revision: head,
		"capability-catalog.json": catalogText(changed),
	};
	const result = drift(baseline, reader(files));
	const catalog = result.findings.filter((finding) => finding.source === "Poyo.ai catalog");
	expect(catalog.map(({ change, subject }) => `${change} ${subject}`)).toEqual([
		`changed ${head}`,
		"added fixture-new",
		"removed fixture-video",
		"changed fixture-edit",
		"changed fixture-image",
	]);
	expect(catalog.find((f) => f.subject === "fixture-image")?.detail).toBe(
		"input_schema.properties.size.enum",
	);
	expect(catalog.find((f) => f.subject === "fixture-edit")?.detail).toBe("billing.credits");
	expect(catalog.find((f) => f.subject === "fixture-new")?.detail).toBe("text2vid");
	const report = renderReport(result);
	for (const subject of ["fixture-new", "fixture-video", "fixture-edit", "fixture-image"])
		expect(report).toContain(subject);
});

/** The upstream with a changed head catalog, and the pinned catalog fetched beside it. */
const movedCatalog = (list: object[], pinnedText = catalogText(items)) => ({
	...upstreamFiles(),
	"capability-catalog.json": catalogText(list),
	"pinned-capability-catalog.json": pinnedText,
});

test("out-of-scope entries changed in categories seen at the pin pass, listed as notices", () => {
	const files = movedCatalog([
		...items.slice(0, 3),
		entry("fixture-chat", "chat", { billing: { type: "fixed", credits: 9 } }),
		entry("fixture-chat-2", "chat"),
	]);
	const result = drift(fixtureBaseline(), reader(files));
	expect(result.findings).toEqual([]);
	expect(
		result.notices?.map(({ change, subject, detail }) => `${change} ${subject} ${detail}`),
	).toEqual([
		expect.stringMatching(/^changed .* the in-scope projection is unchanged/),
		"added fixture-chat-2 chat",
		"changed fixture-chat chat",
	]);
	const report = renderReport(result);
	expect(report).toContain("**No drift.**");
	expect(report).toContain("### Notices");
	expect(report).toContain("- Poyo.ai catalog added: `fixture-chat-2` (`chat`)");
});

test("an entry in a category not seen at the pin, or an in-scope entry that moved, fails", () => {
	for (const [list, subject, detail] of [
		[
			[...items, entry("fixture-song", "music")],
			"fixture-song",
			"music, a category not seen at the pin",
		],
		[
			[...items.slice(0, 3), entry("fixture-chat", "audio")],
			"fixture-chat",
			"audio, a category not seen at the pin",
		],
		[
			[...items.slice(1), entry("fixture-image", "text2img", { description: "new" })],
			"fixture-image",
			"text2img, an in-scope category",
		],
	] as const) {
		const result = drift(fixtureBaseline(), reader(movedCatalog([...list])));
		expect(result.findings.map((finding) => finding.subject)).toEqual([
			expect.any(String),
			subject,
		]);
		expect(result.findings[1].detail).toBe(detail);
		expect(renderReport(result)).toContain("**Drift: 2 findings.**");
	}
});

test("an out-of-scope change fails while the pinned catalog is missing or does not match its digest", () => {
	const list = [...items, entry("fixture-chat-2", "chat")];
	for (const files of [
		{ ...upstreamFiles(), "capability-catalog.json": catalogText(list) },
		movedCatalog(list, `${catalogText(items)} `),
	]) {
		const result = drift(fixtureBaseline(), reader(files));
		expect(result.findings).toHaveLength(1);
		expect(result.findings[0]).toMatchObject({ source: "Poyo.ai catalog", change: "changed" });
		expect(result.findings[0].detail).toContain("the pinned catalog could not be verified");
	}
});

test("a catalog that no longer projects fails with the reason", () => {
	const files = { ...upstreamFiles(), "capability-catalog.json": catalogText([{ model_id: 1 }]) };
	const result = drift(fixtureBaseline(), reader(files));
	expect(result.findings.at(-1)).toMatchObject({ change: "unprojectable" });
	expect(result.findings.at(-1)?.detail).toContain("malformed catalog entry");
});

test("a changed OpenAPI spec fails and names the inputs it changes", () => {
	const files = {
		...upstreamFiles(),
		"openapi/api-manual/one.json": spec(["fixture-image", "fixture-edit"], {
			prompt: { type: "string", maxLength: 100 },
		}),
	};
	const result = drift(fixtureBaseline(), reader(files));
	expect(
		result.findings.map(({ source, change, subject }) => `${source}|${change}|${subject}`),
	).toEqual([
		"OpenAPI spec|changed|/api-manual/one.json",
		"OpenAPI input|changed|fixture-edit",
		"OpenAPI input|changed|fixture-image",
	]);
});

test("a changed docs index fails and lists the specs it adds and removes", () => {
	const files = {
		...upstreamFiles(),
		"llms.txt": index(["/api-manual/one.json", "/api-manual/three.json"]),
		"openapi/api-manual/three.json": spec(["fixture-video"], { prompt: { type: "string" } }),
	};
	const result = drift(fixtureBaseline(), reader(files));
	const lines = result.findings.map(
		({ source, change, subject }) => `${source}|${change}|${subject}`,
	);
	expect(lines).toEqual([
		"Poyo.ai docs index|changed|https://docs.poyo.ai/llms.txt",
		"OpenAPI spec|added|/api-manual/three.json",
		"OpenAPI spec|removed|/api-manual/two.json",
		"OpenAPI input|changed|fixture-video",
	]);
	expect(result.findings[3].detail).toBe("spec /api-manual/two.json → /api-manual/three.json");
});

test("a changed REST page, ToAPIs descriptor page, ToAPIs model list or ToAPIs public catalog fails the same way", () => {
	for (const [kind, url] of [
		["rest", pages.rest],
		["toapis-descriptor", pages.descriptor],
		["toapis-model-list", pages.list],
		["toapis-catalog", pages.catalog],
	] as const) {
		const files = upstreamFiles();
		const baseline = fixtureBaseline(files);
		files[mirrorPath(url)] += "One more line.\n";
		const result = drift(baseline, reader(files));
		expect(result.findings).toHaveLength(1);
		expect(result.findings[0]).toMatchObject({ change: "changed", subject: url });
		expect(result.findings[0].source).toBe(
			{
				rest: "Poyo.ai REST page",
				"toapis-descriptor": "ToAPIs descriptor page",
				"toapis-model-list": "ToAPIs model list",
				"toapis-catalog": "ToAPIs public catalog",
			}[kind],
		);
		expect(result.findings[0].detail).toContain(
			baseline.pages.find((page) => page.url === url)?.sha256.slice(0, 12) as string,
		);
	}
});

test("a source that could not be fetched fails rather than passing unseen", () => {
	for (const missing of [
		"capability-catalog.json",
		"llms.txt",
		"openapi/api-manual/two.json",
		mirrorPath(pages.list),
		mirrorPath(pages.catalog),
	]) {
		const files = upstreamFiles();
		const baseline = fixtureBaseline(files);
		delete files[missing];
		const result = drift(baseline, reader(files));
		expect(result.findings.some((finding) => finding.change === "unreadable")).toBe(true);
	}
});

test("the committed baseline watches every reviewed REST page and both ToAPIs model pages", () => {
	const baseline = committedBaseline();
	const read = (file: string) => JSON.parse(readFileSync(new URL(file, import.meta.url), "utf8"));
	const reviews = read("./sources/page-reviews.json");
	const rest = baseline.pages.filter((page) => page.kind === "rest");
	expect(rest.map(({ url, sha256 }) => ({ url, sha256 }))).toEqual(
		reviews.pages.map(({ url, sha256 }: WatchedPage) => ({ url, sha256 })),
	);
	expect(rest[0].note).toBe("question 10: flux-3-klein prompt, flux-3-klein-edit prompt");
	// The ledger's ToAPIs model list and public catalog, as Markdown, at the digests read on the
	// baseline date.
	const ledger = read("../../docs/media-catalog.v1.json").providers.toapis.sources;
	const toapis = read("./sources/toapis-pages.json");
	expect(toapis.accessed).toBe("2026-11-27");
	expect(baseline.pages.filter((page) => page.kind !== "rest")).toEqual([
		{ ...toapis.pages[0], kind: "toapis-model-list", url: `${ledger.keyList}.md` },
		{ ...toapis.pages[1], kind: "toapis-catalog", url: `${ledger.snapshot}.md` },
	]);
	for (const page of baseline.pages) expect(page.sha256).toMatch(/^[0-9a-f]{64}$/);
	expect(sha256(baseline.catalog)).toBe(record.catalog.projectionSha256);
	expect(sha256(baseline.openapi)).toBe(record.openapi.projectionSha256);
	const result = drift(baseline, () => undefined);
	expect(result.notCovered).toEqual([
		"ToAPIs descriptor pages: no descriptor is recorded yet. Each descriptor that a later slice adds records its page digest.",
	]);
	for (const line of result.notCovered) expect(renderReport(result)).toContain(line);
});

test("a re-pin check passes only when the pinned upstream reproduces the committed projections byte for byte", () => {
	const files = upstreamFiles();
	const baseline = fixtureBaseline(files);
	expect(repinCheck(baseline, reader(files))).toEqual([]);
	expect(renderReport({ findings: [], notCovered: [] }, [], "repin")).toContain("**Reproduced.**");
	const edited = {
		...baseline,
		catalog: baseline.catalog.replace("fixture-video", "fixture-vide0"),
	};
	expect(
		repinCheck(edited, reader(files)).map(({ change, subject }) => `${change} ${subject}`),
	).toEqual([
		`changed ${baseline.record.catalog.file}`,
		"added fixture-video",
		"removed fixture-vide0",
	]);
	const stale = { ...baseline, openapi: `${baseline.openapi.trimEnd()} \n` };
	expect(repinCheck(stale, reader(files))[0]).toMatchObject({
		source: "OpenAPI projection",
		change: "changed",
	});
	const other = { ...files, "capability-catalog.json": `${files["capability-catalog.json"]} ` };
	expect(repinCheck(baseline, reader(other))[0]).toMatchObject({
		change: "unprojectable",
		detail: "The catalog does not match its recorded SHA-256.",
	});
});

test("mirror paths stay inside the mirror and on the expected hosts", () => {
	expect(mirrorPath("https://docs.poyo.ai/api-manual/a/b-1.2.md")).toBe(
		"pages/docs.poyo.ai/api-manual/a/b-1.2.md",
	);
	for (const url of [
		"http://docs.poyo.ai/a.md",
		"https://example.com/a.md",
		"https://docs.poyo.ai/../a.md",
		"https://docs.poyo.ai/a/%2e%2e/b.md",
		"https://docs.poyo.ai/a.md?x=1",
		"https://docs.poyo.ai/",
	])
		expect(() => mirrorPath(url)).toThrow();
});

test("the head revision comes from the anonymous ref advertisement", () => {
	const line = (text: string) => `${(text.length + 4).toString(16).padStart(4, "0")}${text}`;
	const advertisement = `${line("# service=git-upload-pack\n")}0000${line(
		`${head} HEAD\0multi_ack symref=HEAD:refs/heads/main\n`,
	)}${line(`${head} refs/heads/main\n`)}0000`;
	expect(headRevision(advertisement)).toBe(head);
	expect(() => headRevision("0000")).toThrow("HEAD");
	expect(() => headRevision(`${line("not a ref\n")}0000`)).toThrow();
});

/** Serves the fixture upstream over a fake fetch, counting requests and recording headers. */
function fakeUpstream(files: Files, revision = pinned) {
	const advertise = (text: string) => `${(text.length + 4).toString(16).padStart(4, "0")}${text}`;
	const routes = new Map<string, string>([
		[
			"https://github.com/PoyoAPI/poyo-devtools.git/info/refs?service=git-upload-pack",
			`${advertise("# service=git-upload-pack\n")}0000${advertise(`${revision} HEAD\0agent=x\n`)}0000`,
		],
		[
			`https://raw.githubusercontent.com/PoyoAPI/poyo-devtools/${revision}/artifacts/capability-catalog.json`,
			files["capability-catalog.json"],
		],
		["https://docs.poyo.ai/llms.txt", files["llms.txt"]],
		["https://docs.poyo.ai/api-manual/one.json", files["openapi/api-manual/one.json"]],
		["https://docs.poyo.ai/api-manual/two.json", files["openapi/api-manual/two.json"]],
		[pages.rest, files[mirrorPath(pages.rest)]],
		[pages.descriptor, files[mirrorPath(pages.descriptor)]],
		[pages.list, files[mirrorPath(pages.list)]],
		[pages.catalog, files[mirrorPath(pages.catalog)]],
	]);
	if (files["pinned-capability-catalog.json"] !== undefined)
		routes.set(
			`https://raw.githubusercontent.com/PoyoAPI/poyo-devtools/${pinned}/artifacts/capability-catalog.json`,
			files["pinned-capability-catalog.json"],
		);
	const requests: { url: string; init: RequestInit }[] = [];
	const fetcher = async (url: string, init: RequestInit) => {
		requests.push({ url, init });
		const body = routes.get(url);
		return body === undefined ? new Response("missing", { status: 404 }) : new Response(body);
	};
	return { fetcher, requests };
}

test("an online run fetches anonymously into a fresh mirror and passes on an unchanged upstream", async () => {
	const files = upstreamFiles();
	const baseline = fixtureBaseline(files);
	const { fetcher, requests } = fakeUpstream(files);
	const dir = mkdtempSync(join(tmpdir(), "siluet-drift-test-"));
	try {
		const failures = await fetchMirror(dir, baseline, { revision: "head", fetcher });
		expect(failures).toEqual([]);
		for (const { init } of requests) {
			expect(new Headers(init.headers).has("authorization")).toBe(false);
			expect(init.redirect).toBe("error");
			expect(init.signal).toBeInstanceOf(AbortSignal);
		}
		const result = drift(baseline, readMirror(dir));
		expect(result.findings).toEqual([]);
		expect(result.head).toBe(pinned);
		// A re-pin fetch reads the pinned revision without asking for the head.
		const repinDir = mkdtempSync(join(tmpdir(), "siluet-drift-test-"));
		try {
			const before = requests.length;
			expect(await fetchMirror(repinDir, baseline, { revision: "pinned", fetcher })).toEqual([]);
			expect(requests.slice(before).some(({ url }) => url.includes("info/refs"))).toBe(false);
			expect(repinCheck(baseline, readMirror(repinDir))).toEqual([]);
		} finally {
			rmSync(repinDir, { recursive: true });
		}
	} finally {
		rmSync(dir, { recursive: true });
	}
});

test("an online run fetches the pinned catalog only when the head catalog differs from it", async () => {
	const pinnedUrl = `https://raw.githubusercontent.com/PoyoAPI/poyo-devtools/${pinned}/artifacts/capability-catalog.json`;
	const baseline = fixtureBaseline();
	for (const [files, fetched] of [
		[upstreamFiles(), false],
		[movedCatalog([...items, entry("fixture-chat-2", "chat")]), true],
	] as const) {
		const { fetcher, requests } = fakeUpstream(files, head);
		const dir = mkdtempSync(join(tmpdir(), "siluet-drift-test-"));
		try {
			expect(await fetchMirror(dir, baseline, { revision: "head", fetcher })).toEqual([]);
			expect(requests.some(({ url }) => url === pinnedUrl)).toBe(fetched);
			const result = drift(baseline, readMirror(dir));
			expect(result.findings).toEqual([]);
			expect(result.notices?.length).toBe(fetched ? 2 : 0);
		} finally {
			rmSync(dir, { recursive: true });
		}
	}
});

test("an online run refuses a used directory, oversized or failed responses and unsafe spec paths", async () => {
	const files = upstreamFiles();
	const baseline = fixtureBaseline(files);
	const dir = mkdtempSync(join(tmpdir(), "siluet-drift-test-"));
	try {
		const { fetcher } = fakeUpstream(files);
		await fetchMirror(dir, baseline, { revision: "head", fetcher });
		await expect(fetchMirror(dir, baseline, { revision: "head", fetcher })).rejects.toThrow(
			"empty",
		);
	} finally {
		rmSync(dir, { recursive: true });
	}
	for (const [change, expected] of [
		[{ [pages.rest]: "x".repeat(2 ** 20 + 1) }, "size limit"],
		[{ "llms.txt": index(["/api-manual/one.json", "//example.com/two.json"]) }, "unsafe"],
		[{ "llms.txt": index(["/api-manual/../two.json"]) }, "unsafe"],
	] as const) {
		const { fetcher } = fakeUpstream(files);
		const patched = async (url: string, init: RequestInit) => {
			for (const [key, body] of Object.entries(change))
				if (url === key || (key === "llms.txt" && url === "https://docs.poyo.ai/llms.txt"))
					return new Response(body);
			return fetcher(url, init);
		};
		const target = mkdtempSync(join(tmpdir(), "siluet-drift-test-"));
		try {
			const failures = await fetchMirror(target, baseline, { revision: "head", fetcher: patched });
			expect(failures.map(({ reason }) => reason).join("\n")).toContain(expected);
			// Whatever failed is absent from the mirror, so the comparison reports it.
			expect(drift(baseline, readMirror(target)).findings.length).toBeGreaterThan(0);
		} finally {
			rmSync(target, { recursive: true });
		}
	}
	const target = mkdtempSync(join(tmpdir(), "siluet-drift-test-"));
	try {
		const failing = async () => new Response("no", { status: 503 });
		const failures = await fetchMirror(target, baseline, { revision: "head", fetcher: failing });
		expect(failures[0].reason).toContain("HTTP 503");
	} finally {
		rmSync(target, { recursive: true });
	}
});

/** The report's lines, each of which must start with text the report itself wrote. */
const reportLines = (report: string) => report.split("\n");
const ownLine = /^(|## .*|### .*|- .*|\*\*.*|Pinned: .*|Upstream head: .*)$/;

test("hostile catalog text stays inside one code span on its own finding line", () => {
	const hostile = "x``y\n**No drift.** [docs](https://example.com/)\u202e\n::error::spoofed";
	const files = {
		...upstreamFiles(),
		"capability-catalog.json": catalogText([...items, entry(hostile, "text2img")]),
	};
	const result = drift(fixtureBaseline(), reader(files));
	const report = renderReport(result);
	const escaped =
		"x``y\\u000A**No drift.** [docs](https://example.com/)\\u202E\\u000A::error::spoofed";
	expect(report).toContain(`- Poyo.ai catalog added: \`\`\`${escaped}\`\`\` (\`text2img\`)`);
	for (const line of reportLines(report)) expect(line).toMatch(ownLine);
	expect(reportLines(report).filter((line) => line.includes("No drift"))).toHaveLength(1);
	expect(reportLines(report).some((line) => line.trimStart().startsWith("::"))).toBe(false);
});

test("a hostile docs index line and error text are escaped and kept on one line", () => {
	const line = "- [`x`](/a.json)\r::error::spoofed \u2028**No drift.**";
	const files = { ...upstreamFiles(), "llms.txt": `## OpenAPI Specs\n\n${line}\n` };
	const report = renderReport(drift(fixtureBaseline(), reader(files)), [
		{ url: "/a\n::warning::x", reason: "HTTP 500\n::error::spoofed" },
	]);
	expect(report).toContain("\\u000D::error::spoofed \\u2028**No drift.**");
	expect(report).toContain("- `/a\\u000A::warning::x`: `HTTP 500\\u000A::error::spoofed`");
	for (const each of reportLines(report)) expect(each).toMatch(ownLine);
	expect(reportLines(report).some((each) => each.trimStart().startsWith("::"))).toBe(false);
});

test("a 4 MiB malformed catalog entry and a flood of findings keep the report small", () => {
	const files = {
		...upstreamFiles(),
		"capability-catalog.json": catalogText([{ model_id: 1, pad: "x".repeat(4 * 2 ** 20) }]),
	};
	const report = renderReport(drift(fixtureBaseline(), reader(files)));
	expect(report).toContain("malformed catalog entry");
	expect(report.length).toBeLessThan(4096);
	const flood = Array.from({ length: 5000 }, (_, at) => ({
		source: "OpenAPI spec",
		change: "added" as const,
		subject: `/${at}.json${"y".repeat(5000)}`,
		detail: "z".repeat(5000),
	}));
	const big = renderReport({ findings: flood, notCovered: [] }, [
		...Array.from({ length: 5000 }, () => ({ url: "u".repeat(5000), reason: "r".repeat(5000) })),
	]);
	expect(big).toContain("**Drift: 5000 findings.**");
	expect(big).toContain("- and 4900 more findings.");
	expect(big).toContain("- and 4900 more sources.");
	expect(big.length).toBeLessThan(128 * 1024);
});
