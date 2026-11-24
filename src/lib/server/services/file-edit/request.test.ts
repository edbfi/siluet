import { expect, test } from "bun:test";
import { filePlaceholder } from "../../../shared/image-studio/file-edit";
import { createSeedreamDraft } from "../../../shared/image-studio/seedream";
import { parseFileRequest } from "./request";

const stage = (digest = "a", handle = crypto.randomUUID()) => ({
	draft: crypto.randomUUID(),
	handle,
	digest: digest.repeat(64),
	size: 10,
	mime: "image/png" as const,
	transform: "none" as const,
	deadline: 100,
});
const url = (value: string) => ({ kind: "url", url: value });
const file = (descriptor = stage()) => ({ kind: "file", stage: descriptor });
const body = (references: unknown[], extra: Record<string, unknown> = {}) => ({
	draft: { ...createSeedreamDraft("poyo", "edit"), prompt: "Blend these", references },
	count: 1,
	retryLimit: 0,
	acceptUnknown: false,
	...extra,
});

test("file, URL and file parse as three ordered slots with numbered placeholders", () => {
	const first = stage("a");
	const last = stage("b");
	const live = parseFileRequest(
		body([file(first), url(" https://images.example.com/b.png "), file(last)]),
	);
	if (!live || "error" in live) throw new Error("Expected a request.");
	expect(live.version).toBe(3);
	expect(live.slots).toEqual([
		{ kind: "file", stage: first },
		{ kind: "url", url: "https://images.example.com/b.png" },
		{ kind: "file", stage: last },
	]);
	expect(live.files.map(({ position }) => position)).toEqual([1, 3]);
	expect(live.request.body.input?.image_urls).toEqual([
		`${filePlaceholder}#1`,
		"https://images.example.com/b.png",
		`${filePlaceholder}#3`,
	]);
});

test("ten references parse, eleven, a batch, retries and all-URL drafts are invalid", () => {
	const ten = Array.from({ length: 10 }, (_, i) => file(stage(i.toString(16))));
	expect(parseFileRequest(body(ten))).toMatchObject({ version: 3 });
	expect(parseFileRequest(body([...ten, url("https://images.example.com/k.png")]))).toBeNull();
	expect(parseFileRequest(body([file()], { count: 2 }))).toBeNull();
	expect(parseFileRequest(body([file()], { retryLimit: 1 }))).toBeNull();
	expect(parseFileRequest(body([url("https://images.example.com/a.png")]))).toBeNull();
	expect(parseFileRequest(body([]))).toBeNull();
	expect(parseFileRequest(body([{ ...file(), extra: 1 }]))).toBeNull();
});

test("duplicates answer with their positions before any URL is parsed", () => {
	const twice = stage("a");
	expect(parseFileRequest(body([file(twice), url("not a url"), file(twice)]))).toEqual({
		error: "duplicate",
		positions: [1, 3],
	});
	expect(parseFileRequest(body([file(stage("a")), file(stage("a"))]))).toEqual({
		error: "duplicate",
		positions: [1, 2],
	});
	expect(
		parseFileRequest(
			body([
				file(),
				url("https://images.example.com/a.png"),
				url(" https://images.example.com/a.png"),
			]),
		),
	).toEqual({ error: "duplicate", positions: [2, 3] });
});

test("a URL slot may not name the upload placeholder host", () => {
	expect(parseFileRequest(body([file(), url(filePlaceholder)]))).toBeNull();
	expect(parseFileRequest(body([file(), url(`${filePlaceholder}#1`)]))).toBeNull();
	expect(
		parseFileRequest(body([file(), url("https://UPLOAD-PLACEHOLDER.example.org./x")])),
	).toBeNull();
});

test("an R1b body parses as version 2 with its bare placeholder", () => {
	const descriptor = stage("c");
	const live = parseFileRequest({
		...body([{ kind: "upload", url: filePlaceholder }]),
		stage: descriptor,
		token: "file2.x",
	});
	if (!live || "error" in live) throw new Error("Expected a request.");
	expect(live.version).toBe(2);
	expect(live.slots).toEqual([{ kind: "file", stage: descriptor }]);
	expect(live.draft.references).toEqual([{ kind: "upload", url: filePlaceholder }]);
	expect(live.request.body.input?.image_urls).toEqual([filePlaceholder]);
	// A numbered placeholder exists only in version 3.
	expect(
		parseFileRequest({
			...body([{ kind: "upload", url: `${filePlaceholder}#1` }]),
			stage: descriptor,
		}),
	).toBeNull();
	// A version 3 body never carries a top-level stage.
	expect(parseFileRequest({ ...body([file()]), stage: descriptor })).toBeNull();
});
