// bun run catalog:drift: compares the pinned Poyo.ai sources with what is published now and fails
// with an evidence diff. It never changes the app: behaviour moves only through a reviewed re-pin.
//
//   bun run catalog:drift                     fetch the upstream head into a fresh temporary
//                                             directory and compare every recorded source
//   bun run catalog:drift --repin             fetch the pinned revision and check that projecting
//                                             it reproduces the committed projections byte for byte
//   ... --mirror <dir>                        compare a mirror fetched earlier, offline
//
// Every fetch is an anonymous public GET with a size limit, a timeout and no redirects, within an
// overall deadline, into a directory outside the repository. Fetched files are untrusted data:
// they are hashed and parsed as JSON or text, never executed. Nothing here calls a provider API
// or reads a credential.
import {
	mkdirSync,
	mkdtempSync,
	readdirSync,
	readFileSync,
	realpathSync,
	statSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import ledger from "../../docs/media-catalog.v1.json";
import { canonicalJson } from "../../src/lib/shared/media-catalog/canonical";
import {
	indexedSpecs,
	inScope,
	openApiScope,
	projectCatalog,
	projectOpenApi,
	repin,
	sha256,
} from "./project";
import pageReviews from "./sources/page-reviews.json";
import sourceRecord from "./sources/sources.json";
import toapisPages from "./sources/toapis-pages.json";

const short = (digest: string) => `${digest.slice(0, 12)}…`;

type SourceRecord = typeof sourceRecord;
/** A page whose digest a reviewed state depends on. */
export type WatchedPage = {
	kind: "rest" | "toapis-descriptor" | "toapis-model-list" | "toapis-catalog";
	url: string;
	sha256: string;
	note: string;
};
/** What a re-pin recorded: the source record, the committed projections and the watched pages. */
export type Baseline = {
	record: SourceRecord;
	catalog: string;
	openapi: string;
	pages: WatchedPage[];
};
export type Finding = {
	source: string;
	change: "added" | "removed" | "changed" | "unreadable" | "unprojectable";
	subject: string;
	detail?: string;
};
export type DriftResult = {
	head?: string;
	findings: Finding[];
	/** Changes that cannot affect eligibility: reported, never failing. */
	notices: Finding[];
	notCovered: string[];
	pinned: string;
	pages: number;
	specs: number;
};
/** Reads a mirror-relative path, or undefined when the file was not fetched. */
export type Mirror = (path: string) => string | undefined;

const pageSources: Record<WatchedPage["kind"], string> = {
	rest: "Poyo.ai REST page",
	"toapis-descriptor": "ToAPIs descriptor page",
	"toapis-model-list": "ToAPIs model list",
	"toapis-catalog": "ToAPIs public catalog",
};
const notCoveredKinds: [WatchedPage["kind"], string][] = [
	[
		"toapis-descriptor",
		"ToAPIs descriptor pages: no descriptor is recorded yet. Each descriptor that a later slice adds records its page digest.",
	],
];

/** The baseline the repository records today. */
export function committedBaseline(): Baseline {
	const read = (file: string) =>
		readFileSync(new URL(`./sources/${file}`, import.meta.url), "utf8");
	const rest = pageReviews.pages.map(
		(page): WatchedPage => ({
			kind: "rest",
			url: page.url,
			sha256: page.sha256,
			note: `question 10: ${Object.entries(page.silent)
				.flatMap(([model, fields]) => (fields as string[]).map((field) => `${model} ${field}`))
				.join(", ")}`,
		}),
	);
	// The ledger's ToAPIs model list and public catalog, as Markdown, at their recorded digests.
	const { keyList, snapshot } = ledger.providers.toapis.sources;
	const [list, catalog] = toapisPages.pages;
	const toapis: WatchedPage[] = [
		{ ...list, kind: "toapis-model-list", url: `${keyList}.md` },
		{ ...catalog, kind: "toapis-catalog", url: `${snapshot}.md` },
	];
	// ToAPIs descriptors (G10a, G11a) record no page digest yet, so none is watched, and the
	// report says so.
	return {
		record: sourceRecord,
		catalog: read(sourceRecord.catalog.file),
		openapi: read(sourceRecord.openapi.file),
		pages: [...rest, ...toapis],
	};
}

const segment = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
const pageHosts = new Set(["docs.poyo.ai", "docs.toapis.com"]);
const safePath = (path: string) =>
	path.startsWith("/") &&
	path
		.slice(1)
		.split("/")
		.every((part) => segment.test(part));

/**
 * The mirror path of a watched page. Only plain HTTPS paths on the docs hosts, without userinfo,
 * a query or a fragment, are accepted.
 */
export function mirrorPath(url: string) {
	const parsed = new URL(url);
	if (
		parsed.protocol !== "https:" ||
		parsed.username ||
		parsed.password ||
		!pageHosts.has(parsed.host) ||
		parsed.search ||
		parsed.hash ||
		!safePath(parsed.pathname) ||
		parsed.href !== url
	)
		throw new Error(`Refusing unsafe page URL ${url}.`);
	return `pages/${parsed.host}${parsed.pathname}`;
}

/** The mirror path of a spec the docs index lists, or null for an unsafe path. */
const specPath = (path: string) => (safePath(path) ? `openapi${path}` : null);

/** The largest file a mirror holds: the biggest fetch limit. */
const mirrorFileLimit = 4 * 2 ** 20;

/**
 * A reader over a mirror directory that never leaves it: a relative path whose real path, after
 * every link, is a regular file inside the mirror's real root and within `mirrorFileLimit`.
 */
export function readMirror(dir: string): Mirror {
	const root = realpathSync(dir);
	const within = (file: string) => {
		const inside = relative(root, file);
		return !!inside && !inside.startsWith("..") && !isAbsolute(inside);
	};
	return (path) => {
		if (isAbsolute(path) || !within(resolve(root, path))) return undefined;
		let file: string;
		try {
			file = realpathSync(resolve(root, path));
		} catch {
			return undefined;
		}
		const stat = statSync(file);
		return within(file) && stat.isFile() && stat.size <= mirrorFileLimit
			? readFileSync(file, "utf8")
			: undefined;
	};
}

type Json = null | boolean | number | string | Json[] | { [key: string]: Json };
const isObject = (value: Json | undefined): value is { [key: string]: Json } =>
	!!value && typeof value === "object" && !Array.isArray(value);
const own = (value: { [key: string]: Json }, key: string) =>
	Object.hasOwn(value, key) ? value[key] : undefined;

/** The dotted paths at which two values differ. Arrays compare whole, so an enum is one path. */
export function changedPaths(before: Json | undefined, after: Json | undefined, at = ""): string[] {
	if (isObject(before) && isObject(after))
		return [...new Set([...Object.keys(before), ...Object.keys(after)])]
			.sort()
			.flatMap((key) => changedPaths(own(before, key), own(after, key), at ? `${at}.${key}` : key));
	return canonicalJson(before) === canonicalJson(after) ? [] : [at || "(whole value)"];
}

const listPaths = (paths: string[], limit = 8) =>
	paths.length > limit
		? `${paths.slice(0, limit).join(", ")} and ${paths.length - limit} more`
		: paths.join(", ");
const byId = <T extends { model_id: string }>(entries: T[]) =>
	new Map(entries.map((entry) => [entry.model_id, entry]));
type Entry = { model_id: string; category: string } & { [key: string]: Json };

/** Added, removed and changed in-scope entries, in that order and each sorted by ID. */
function entryChanges(source: string, before: string, after: string): Finding[] {
	const old = byId((JSON.parse(before) as { entries: Entry[] }).entries);
	const now = byId((JSON.parse(after) as { entries: Entry[] }).entries);
	const ids = [...new Set([...old.keys(), ...now.keys()])].sort();
	const findings: Finding[] = [];
	for (const id of ids)
		if (!old.has(id))
			findings.push({ source, change: "added", subject: id, detail: now.get(id)?.category });
	for (const id of ids) if (!now.has(id)) findings.push({ source, change: "removed", subject: id });
	for (const id of ids) {
		const paths = old.has(id) && now.has(id) ? changedPaths(old.get(id), now.get(id)) : [];
		if (paths.length)
			findings.push({ source, change: "changed", subject: id, detail: listPaths(paths) });
	}
	return findings;
}

/**
 * Entries that moved between the pinned catalog and the head while the in-scope projection stayed
 * byte-identical. An added or changed entry passes as a notice only when its category is outside
 * the in-scope set and was already present at the pin; any other could be a new media category,
 * so it fails. Removed entries are notices. Null when a model ID repeats, so nothing is compared.
 */
function outOfScopeChanges(source: string, pinnedText: string, headText: string) {
	const list = (text: string) => (JSON.parse(text) as { items: Entry[] }).items;
	const [before, after] = [list(pinnedText), list(headText)];
	const [old, now] = [byId(before), byId(after)];
	if (old.size !== before.length || now.size !== after.length) return null;
	const seen = new Set(before.map((item) => item.category));
	const ids = [...new Set([...old.keys(), ...now.keys()])].sort();
	const findings: Finding[] = [];
	const notices: Finding[] = [];
	const classify = (change: Finding["change"], item: Entry) => {
		const reason = inScope(item)
			? "an in-scope category"
			: !seen.has(item.category) && "a category not seen at the pin";
		if (reason)
			findings.push({
				source,
				change,
				subject: item.model_id,
				detail: `${item.category}, ${reason}`,
			});
		else notices.push({ source, change, subject: item.model_id, detail: item.category });
	};
	for (const id of ids) if (!old.has(id)) classify("added", now.get(id) as Entry);
	for (const id of ids) if (!now.has(id)) classify("removed", old.get(id) as Entry);
	for (const id of ids)
		if (old.has(id) && now.has(id) && canonicalJson(old.get(id)) !== canonicalJson(now.get(id)))
			classify("changed", now.get(id) as Entry);
	return { findings, notices };
}

type OpenApiProjection = {
	index: { sha256: string; url: string };
	manifest: { path: string; sha256: string }[];
	models: Record<string, { input: string; spec: string; shared?: true }>;
};

/** Added, removed and changed per-model OpenAPI inputs between two projections. */
function modelChanges(source: string, before: OpenApiProjection, after: OpenApiProjection) {
	const ids = [...new Set([...Object.keys(before.models), ...Object.keys(after.models)])].sort();
	const findings: Finding[] = [];
	for (const id of ids) {
		const [old, now] = [before.models[id], after.models[id]];
		if (!old) findings.push({ source, change: "added", subject: id, detail: `spec ${now.spec}` });
		else if (!now)
			findings.push({ source, change: "removed", subject: id, detail: `spec ${old.spec}` });
		else {
			const details = [
				old.input !== now.input && `input ${short(old.input)} → ${short(now.input)}`,
				old.spec !== now.spec && `spec ${old.spec} → ${now.spec}`,
				!!old.shared !== !!now.shared && (now.shared ? "now shared" : "now its own branch"),
			].filter(Boolean);
			if (details.length)
				findings.push({ source, change: "changed", subject: id, detail: details.join("; ") });
		}
	}
	return findings;
}

const errorText = (error: unknown) => (error instanceof Error ? error.message : String(error));

/**
 * Compares a mirror of the upstream with the baseline: the catalog at the upstream head against
 * the committed projection, the docs index and every OpenAPI spec it lists against the recorded
 * digests and per-model inputs, and every watched page against its recorded digest.
 */
export function drift(baseline: Baseline, read: Mirror): DriftResult {
	const { record } = baseline;
	const findings: Finding[] = [];
	const notices: Finding[] = [];
	// The head revision is untrusted mirror text; only a full commit SHA is reported.
	const head = /^[0-9a-f]{40}$/.exec(read("revision")?.trim() ?? "")?.[0];

	// The catalog at the head, projected exactly as a re-pin would.
	const catalogSource = "Poyo.ai catalog";
	const upstream = read("capability-catalog.json");
	if (upstream === undefined)
		findings.push({
			source: catalogSource,
			change: "unreadable",
			subject: head ?? "upstream head",
		});
	else if (sha256(upstream) !== record.catalog.upstreamSha256) {
		const subject = head ?? "upstream head";
		const digest = `sha256 ${short(record.catalog.upstreamSha256)} → ${short(sha256(upstream))}`;
		try {
			const projected = projectCatalog(upstream, record.catalog.revision);
			const entries = entryChanges(catalogSource, baseline.catalog, projected);
			if (entries.length) {
				findings.push({ source: catalogSource, change: "changed", subject, detail: digest });
				findings.push(...entries);
			} else {
				// The in-scope projection is unchanged, so the pinned catalog shows what moved outside it.
				const pinnedText = read("pinned-capability-catalog.json");
				const outside =
					pinnedText !== undefined && sha256(pinnedText) === record.catalog.upstreamSha256
						? outOfScopeChanges(catalogSource, pinnedText, upstream)
						: undefined;
				const unchanged = `${digest}; the in-scope projection is unchanged`;
				if (outside && !outside.findings.length)
					notices.push(
						{
							source: catalogSource,
							change: "changed",
							subject,
							detail: `${unchanged}, and every entry that moved is outside it, in a category seen at the pin`,
						},
						...outside.notices,
					);
				else {
					findings.push({
						source: catalogSource,
						change: "changed",
						subject,
						detail:
							outside === undefined
								? `${unchanged}, but the pinned catalog could not be verified, so the entries outside it were not compared`
								: outside === null
									? `${unchanged}, but the catalog repeats a model ID, so the entries outside it were not compared`
									: `${unchanged}, but entries outside it moved in a way that could affect eligibility`,
					});
					if (outside) {
						findings.push(...outside.findings);
						notices.push(...outside.notices);
					}
				}
			}
		} catch (error) {
			findings.push({ source: catalogSource, change: "changed", subject, detail: digest });
			findings.push({
				source: catalogSource,
				change: "unprojectable",
				subject,
				detail: errorText(error),
			});
		}
	}

	// The docs index, the specs it lists and each in-scope model's input.
	const committed = JSON.parse(baseline.openapi) as OpenApiProjection;
	const indexSource = "Poyo.ai docs index";
	const index = read("llms.txt");
	let specs = 0;
	if (index === undefined)
		findings.push({ source: indexSource, change: "unreadable", subject: record.openapi.index });
	else {
		if (sha256(index) !== committed.index.sha256)
			findings.push({
				source: indexSource,
				change: "changed",
				subject: record.openapi.index,
				detail: `sha256 ${short(committed.index.sha256)} → ${short(sha256(index))}`,
			});
		let listed: string[] | undefined;
		try {
			listed = indexedSpecs(index);
		} catch (error) {
			findings.push({
				source: indexSource,
				change: "unprojectable",
				subject: record.openapi.index,
				detail: errorText(error),
			});
		}
		if (listed) {
			specs = listed.length;
			const specSource = "OpenAPI spec";
			const recorded = new Map(committed.manifest.map((file) => [file.path, file.sha256]));
			let unreadable = false;
			for (const path of listed) {
				const mirrored = specPath(path);
				const text = mirrored === null ? undefined : read(mirrored);
				if (text === undefined) {
					unreadable = true;
					findings.push({
						source: specSource,
						change: "unreadable",
						subject: path,
						...(mirrored === null && { detail: "unsafe path" }),
					});
				} else if (!recorded.has(path))
					findings.push({
						source: specSource,
						change: "added",
						subject: path,
						detail: `sha256 ${short(sha256(text))}`,
					});
				else if (recorded.get(path) !== sha256(text))
					findings.push({
						source: specSource,
						change: "changed",
						subject: path,
						detail: `sha256 ${short(recorded.get(path) as string)} → ${short(sha256(text))}`,
					});
			}
			for (const path of recorded.keys())
				if (!listed.includes(path))
					findings.push({ source: specSource, change: "removed", subject: path });
			// Each spec that was read is projected as a re-pin would, against the pinned catalog's
			// scope, so the evidence names the inputs a change touches.
			if (!unreadable)
				try {
					const projected = projectOpenApi(
						index,
						(path) => read(specPath(path) as string) as string,
						openApiScope(baseline.catalog, record),
						record.openapi.date,
						new Set(record.openapi.noModelSpecs.paths),
					);
					findings.push(
						...modelChanges("OpenAPI input", committed, JSON.parse(projected) as OpenApiProjection),
					);
				} catch (error) {
					findings.push({
						source: "OpenAPI input",
						change: "unprojectable",
						subject: record.openapi.index,
						detail: errorText(error),
					});
				}
		}
	}

	// Each page behind a reviewed state.
	for (const page of baseline.pages) {
		const source = pageSources[page.kind];
		const text = read(mirrorPath(page.url));
		if (text === undefined)
			findings.push({ source, change: "unreadable", subject: page.url, detail: page.note });
		else if (sha256(text) !== page.sha256)
			findings.push({
				source,
				change: "changed",
				subject: page.url,
				detail: `sha256 ${short(page.sha256)} → ${short(sha256(text))}; reviewed for ${page.note}`,
			});
	}

	return {
		...(head && { head }),
		findings,
		notices,
		notCovered: notCoveredKinds
			.filter(([kind]) => !baseline.pages.some((page) => page.kind === kind))
			.map(([, text]) => text),
		pinned: record.catalog.revision,
		pages: baseline.pages.length,
		specs,
	};
}

/**
 * At a re-pin: the fetched upstream must match its recorded SHA-256, and projecting it must
 * reproduce both committed projections byte for byte.
 */
export function repinCheck(baseline: Baseline, read: Mirror): Finding[] {
	const { record } = baseline;
	let projected: { catalog: string; openapi: string };
	try {
		projected = repin((path) => {
			const text = read(path.startsWith("openapi/") ? (specPath(path.slice(7)) ?? "") : path);
			if (text === undefined) throw new Error(`${path} could not be read from the mirror.`);
			return text;
		}, record);
	} catch (error) {
		return [
			{
				source: "Poyo.ai catalog",
				change: "unprojectable",
				subject: record.catalog.revision,
				detail: errorText(error),
			},
		];
	}
	const findings: Finding[] = [];
	const compare = (source: string, file: string, committed: string, reproduced: string) => {
		if (committed === reproduced) return false;
		findings.push({
			source,
			change: "changed",
			subject: file,
			detail: `committed sha256 ${short(sha256(committed))}, reproduced ${short(sha256(reproduced))}`,
		});
		return true;
	};
	if (
		compare("Poyo.ai catalog projection", record.catalog.file, baseline.catalog, projected.catalog)
	)
		findings.push(
			...entryChanges("Poyo.ai catalog projection", baseline.catalog, projected.catalog),
		);
	if (compare("OpenAPI projection", record.openapi.file, baseline.openapi, projected.openapi))
		findings.push(
			...modelChanges(
				"OpenAPI projection",
				JSON.parse(baseline.openapi) as OpenApiProjection,
				JSON.parse(projected.openapi) as OpenApiProjection,
			),
		);
	return findings;
}

/** The revision HEAD names in a Git smart-HTTP ref advertisement. */
export function headRevision(advertisement: string) {
	for (let at = 0; at < advertisement.length; ) {
		const length = Number.parseInt(advertisement.slice(at, at + 4), 16);
		if (!/^[0-9a-f]{4}$/.test(advertisement.slice(at, at + 4)) || (length > 0 && length < 4))
			throw new Error("The ref advertisement is malformed.");
		if (length === 0) {
			at += 4;
			continue;
		}
		const line = advertisement.slice(at + 4, at + length);
		const match = /^([0-9a-f]{40}) HEAD(?:\0|\n)/.exec(line);
		if (match) return match[1];
		at += length;
	}
	throw new Error("The ref advertisement names no HEAD.");
}

type Fetcher = (url: string, init: RequestInit) => Promise<Response>;
const limits = {
	refs: mirrorFileLimit,
	catalog: mirrorFileLimit,
	index: 2 ** 20,
	spec: 2 ** 20,
	page: 2 ** 20,
};

/** The whole fetch stays well under the workflow job's 10 minutes. */
const fetchDeadlineMs = 5 * 60_000;
const pastDeadline = "not fetched: the overall fetch deadline passed";

/** One anonymous GET, bounded in size and time, decoded as strict UTF-8. */
async function getText(fetcher: Fetcher, url: string, maxBytes: number, deadline: AbortSignal) {
	const response = await fetcher(url, {
		redirect: "error",
		signal: AbortSignal.any([AbortSignal.timeout(30_000), deadline]),
	});
	if (!response.ok || !response.body) {
		await response.body?.cancel().catch(() => {});
		throw new Error(`HTTP ${response.status}`);
	}
	const declared = Number(response.headers.get("content-length"));
	if (declared > maxBytes) {
		await response.body.cancel();
		throw new Error("over the size limit");
	}
	const reader = response.body.getReader();
	const chunks: Uint8Array[] = [];
	let bytes = 0;
	try {
		while (true) {
			const { done, value } = await reader.read();
			if (done) break;
			bytes += value.byteLength;
			if (bytes > maxBytes) throw new Error("over the size limit");
			chunks.push(value);
		}
	} catch (error) {
		await reader.cancel().catch(() => {});
		throw error;
	}
	return new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(Buffer.concat(chunks));
}

/**
 * Fetches the upstream into an empty directory in the mirror layout `drift` and `repinCheck`
 * read: at the head, the catalog, the docs index, its specs and every watched page; at the pin,
 * only what a re-pin projects. A file that cannot be fetched, including every one still pending
 * at the overall deadline, is left out and returned as a failure, so the comparison reports it
 * rather than passing.
 */
export async function fetchMirror(
	dir: string,
	baseline: Baseline,
	{
		revision,
		fetcher,
		deadlineMs = fetchDeadlineMs,
	}: { revision: "head" | "pinned"; fetcher: Fetcher; deadlineMs?: number },
) {
	if (readdirSync(dir).length) throw new Error(`The mirror directory ${dir} must be empty.`);
	const { record } = baseline;
	const deadline = AbortSignal.timeout(deadlineMs);
	const failures: { url: string; reason: string }[] = [];
	const save = (path: string, text: string) => {
		const file = join(dir, path);
		mkdirSync(dirname(file), { recursive: true });
		writeFileSync(file, text);
	};
	const get = async (url: string, maxBytes: number) => {
		try {
			if (deadline.aborted) throw new Error(pastDeadline);
			return await getText(fetcher, url, maxBytes, deadline);
		} catch (error) {
			failures.push({ url, reason: deadline.aborted ? pastDeadline : errorText(error) });
			return undefined;
		}
	};
	const fetchTo = async (url: string, path: string, maxBytes: number) => {
		const text = await get(url, maxBytes);
		if (text !== undefined) save(path, text);
		return text;
	};

	// The pinned upstream URL names the repository and the artifact path around the revision.
	const [repository, artifact] = record.catalog.upstream
		.replace("https://raw.githubusercontent.com/", "")
		.split(`/${record.catalog.revision}/`);
	let rev: string | undefined = record.catalog.revision;
	if (revision === "head") {
		const refsUrl = `https://github.com/${repository}.git/info/refs?service=git-upload-pack`;
		const refs = await get(refsUrl, limits.refs);
		try {
			rev = refs === undefined ? undefined : headRevision(refs);
		} catch (error) {
			failures.push({ url: refsUrl, reason: errorText(error) });
			rev = undefined;
		}
	}
	if (rev) {
		save("revision", `${rev}\n`);
		const text = await fetchTo(
			`https://raw.githubusercontent.com/${repository}/${rev}/${artifact}`,
			"capability-catalog.json",
			limits.catalog,
		);
		// A head catalog that differs from the pin is compared entry by entry with the pinned one.
		if (revision === "head" && text !== undefined && sha256(text) !== record.catalog.upstreamSha256)
			await fetchTo(record.catalog.upstream, "pinned-capability-catalog.json", limits.catalog);
	}

	const index = await fetchTo(record.openapi.index, "llms.txt", limits.index);
	let listed: string[] = [];
	try {
		listed = index === undefined ? [] : indexedSpecs(index);
	} catch (error) {
		failures.push({ url: record.openapi.index, reason: errorText(error) });
	}
	const origin = new URL(record.openapi.index).origin;
	const jobs = [
		...listed.map((path) => () => {
			const target = specPath(path);
			if (target === null) {
				failures.push({ url: path, reason: "unsafe spec path, not fetched" });
				return Promise.resolve();
			}
			return fetchTo(`${origin}${path}`, target, limits.spec);
		}),
		// A re-pin projects only the catalog and the specs, so it reads no watched page.
		...(revision === "head" ? baseline.pages : []).map(
			(page) => () => fetchTo(page.url, mirrorPath(page.url), limits.page),
		),
	];
	// A few requests at a time, so one run stays polite to the docs host.
	for (let at = 0; at < jobs.length; at += 6)
		await Promise.all(jobs.slice(at, at + 6).map((job) => job()));
	return failures;
}

const fieldLimit = 200;
const listLimit = 100;
// Control, format (bidi, zero-width), unpaired surrogate and line or paragraph separator characters.
const invisible = /[\p{Cc}\p{Cf}\p{Cs}\p{Zl}\p{Zp}]/gu;

/**
 * Untrusted text as one inline code span on the current line. Invisible and line-breaking
 * characters become visible `\uXXXX` escapes, so no untrusted text starts a line (nor a workflow
 * command), long text is cut, and the fence is longer than any backtick run inside.
 */
export function untrusted(text: string) {
	let inner = text.replace(
		invisible,
		(char) => `\\u${(char.codePointAt(0) as number).toString(16).toUpperCase().padStart(4, "0")}`,
	);
	if (inner.length > fieldLimit) {
		const end = /[\uD800-\uDBFF]/.test(inner[fieldLimit - 1]) ? fieldLimit - 1 : fieldLimit;
		inner = `${inner.slice(0, end)}…`;
	}
	if (!inner) return "(empty)";
	const fence = "`".repeat(Math.max(0, ...(inner.match(/`+/g) ?? []).map((run) => run.length)) + 1);
	const pad = /^`|`$|^ .* $/.test(inner) ? " " : "";
	return `${fence}${pad}${inner}${pad}${fence}`;
}

/** At most `listLimit` bullet lines, then one line counting the rest. */
const bullets = <T>(list: T[], line: (item: T) => string, noun: string) => [
	...list.slice(0, listLimit).map((item) => `- ${line(item)}`),
	...(list.length > listLimit ? [`- and ${list.length - listLimit} more ${noun}.`] : []),
];

/**
 * A Markdown report for the terminal and the workflow summary. Every string that came from a
 * fetched source or an error goes through `untrusted`, and each list is capped.
 */
export function renderReport(
	result: Pick<DriftResult, "findings" | "notCovered"> & Partial<DriftResult>,
	failures: { url: string; reason: string }[] = [],
	mode: "drift" | "repin" = "drift",
) {
	const lines = [`## ${mode === "repin" ? "Catalog re-pin check" : "Catalog drift"}`, ""];
	if (result.pinned)
		lines.push(
			mode === "repin"
				? `Pinned: Poyo.ai catalog \`${result.pinned}\`.`
				: `Pinned: Poyo.ai catalog \`${result.pinned.slice(0, 7)}\`. Checked the catalog, the docs index, ${result.specs ?? 0} OpenAPI specs it lists and ${result.pages ?? 0} watched pages.`,
		);
	if (result.head) lines.push(`Upstream head: \`${result.head}\`.`);
	lines.push("");
	if (result.findings.length) {
		const count = `${result.findings.length} finding${result.findings.length === 1 ? "" : "s"}`;
		lines.push(
			mode === "repin"
				? `**Not reproduced: ${count}.** Re-project from this mirror before the re-pin lands.`
				: `**Drift: ${count}.** The app keeps its pinned sources until a reviewed re-pin.`,
			"",
			...bullets(
				result.findings,
				({ source, change, subject, detail }) =>
					`${source} ${change}: ${untrusted(subject)}${detail ? ` (${untrusted(detail)})` : ""}`,
				"findings",
			),
		);
	} else
		lines.push(
			mode === "repin"
				? "**Reproduced.** The upstream matches its recorded SHA-256, and projecting it reproduces both committed projections byte for byte."
				: "**No drift.** Every recorded source matches.",
		);
	if (result.notices?.length)
		lines.push(
			"",
			"### Notices",
			"",
			"Outside the in-scope projection, so these cannot change what is eligible.",
			"",
			...bullets(
				result.notices,
				({ source, change, subject, detail }) =>
					`${source} ${change}: ${untrusted(subject)}${detail ? ` (${untrusted(detail)})` : ""}`,
				"notices",
			),
		);
	if (failures.length)
		lines.push(
			"",
			"### Not fetched",
			"",
			...bullets(
				failures,
				({ url, reason }) => `${untrusted(url)}: ${untrusted(reason)}`,
				"sources",
			),
		);
	if (result.notCovered.length) {
		lines.push("", "### Not yet covered", "");
		for (const text of result.notCovered) lines.push(`- ${text}`);
	}
	return `${lines.join("\n")}\n`;
}

/** The options in order, or undefined for any argument that is not one, repeated or incomplete. */
export function parseArgs(args: string[]) {
	const options: { repin: boolean; mirror?: string } = { repin: false };
	for (let at = 0; at < args.length; at += 1) {
		if (args[at] === "--repin" && !options.repin) options.repin = true;
		else if (args[at] === "--mirror" && options.mirror === undefined) {
			const value = args[at + 1];
			if (!value || value.startsWith("-")) return undefined;
			options.mirror = value;
			at += 1;
		} else return undefined;
	}
	return options;
}

if (import.meta.main) {
	const options = parseArgs(process.argv.slice(2));
	if (!options) {
		console.error("Usage: bun scripts/media-catalog/drift.ts [--repin] [--mirror <dir>]");
		process.exit(2);
	}
	const { repin: repinMode, mirror } = options;
	const baseline = committedBaseline();
	let dir = mirror;
	let failures: { url: string; reason: string }[] = [];
	if (!dir) {
		dir = mkdtempSync(join(tmpdir(), "siluet-catalog-drift-"));
		failures = await fetchMirror(dir, baseline, {
			revision: repinMode ? "pinned" : "head",
			fetcher: fetch,
		});
	}
	console.error(`Mirror: ${dir}`);
	const result = repinMode
		? {
				findings: repinCheck(baseline, readMirror(dir)),
				notCovered: [],
				pinned: baseline.record.catalog.revision,
			}
		: drift(baseline, readMirror(dir));
	console.log(renderReport(result, failures, repinMode ? "repin" : "drift"));
	if (result.findings.length || failures.length) process.exitCode = 1;
}
