import { expect, test } from "bun:test";
import { createSeedreamDraft } from "../../../shared/image-studio/seedream";
import { parseQueueRequest } from "./request";

const draft = { ...createSeedreamDraft("poyo"), prompt: "a folding screen" };
const request = { draft, count: 1, retryLimit: 0, acceptUnknown: false };

test("live submission strictly validates one text generation before building its provider body", () => {
	expect(parseQueueRequest(request)?.input.prompt).toBe(draft.prompt);
	for (const change of [
		{ count: 6 },
		{ count: 2.2 },
		{ retryLimit: -1 },
		{ retryLimit: 4 },
		{ acceptUnknown: "true" },
		{ quote: { status: "known" } },
		{ draft: { ...draft, operation: "edit" } },
		{ draft: { ...draft, references: [{ url: "https://example.org/a" }] } },
		{ draft: { ...draft, options: { ...draft.options, background: "not-supported" } } },
		{ draft: { ...draft, provider: "other" } },
		{ draft: { ...draft, prompt: " " } },
	])
		expect(parseQueueRequest({ ...request, ...change })).toBeNull();
});

test.each([null, 512.5])(
	"only validate edited numeric fields in exact dimension mode (%s)",
	(width) => {
		const toapis = { ...createSeedreamDraft("toapis"), prompt: draft.prompt };
		const parse = (sizeMode: "tier" | "pixels") =>
			parseQueueRequest({
				...request,
				draft: { ...toapis, options: { ...toapis.options, sizeMode, width, height: 2048 } },
			});
		expect(parse("tier")?.request.body).toEqual(
			parseQueueRequest({ ...request, draft: toapis })?.request.body,
		);
		expect(parse("pixels")).toBeNull();
	},
);

const editUrl = "https://images.example.org/fan%2fdetail%20one?sig=A%2bZ&v=1&v=2#panel";
const editDraft = {
	...createSeedreamDraft("poyo", "edit"),
	prompt: "add fine lines to the folding screen",
	references: [{ kind: "url", url: `  ${editUrl}  `, hostname: "forged.example.org" }],
};

test.each(["poyo", "toapis"] as const)(
	"a %s edit uses one public URL with its exact trimmed spelling",
	(provider) => {
		const parsed = parseQueueRequest({ ...request, draft: { ...editDraft, provider } });
		expect(parsed?.input.references).toEqual([
			{ kind: "url", url: editUrl, hostname: "images.example.org" },
		]);
		if (provider === "poyo") {
			expect(parsed?.request.body).toEqual({
				model: "seedream-5.5",
				input: {
					prompt: editDraft.prompt,
					size: "auto",
					resolution: "2K",
					background: "auto",
					output_format: "png",
					enable_safety_checker: false,
					image_urls: [editUrl],
				},
			});
		} else {
			expect(parsed?.request.body).toEqual({
				model: "doubao-seedream-5-5",
				prompt: editDraft.prompt,
				size: "2K",
				disable_nsfw: false,
				metadata: { background: "auto", output_format: "png", watermark: false },
				image_urls: [editUrl],
			});
		}
	},
);

test.each(["poyo", "toapis"] as const)(
	"a %s edit keeps every public URL and derived hostname in slot order",
	(provider) => {
		const urls = [
			editUrl.replace("A%2bZ", "another"),
			editUrl.replace("images.example.org", "photos.example.org"),
			editUrl,
			...Array.from({ length: 7 }, (_, index) => `${editUrl}-${index}`),
		];
		for (const count of [2, 10]) {
			const ordered = urls.slice(0, count);
			const references = ordered.map((url) => ({ ...editDraft.references[0], url: `  ${url}  ` }));
			const parsed = parseQueueRequest({
				...request,
				draft: { ...editDraft, provider, references },
			});
			expect(parsed?.input.references).toEqual(
				ordered.map((url) => ({ kind: "url", url, hostname: new URL(url).hostname })),
			);
			expect(parsed?.request.body).toMatchObject(
				provider === "poyo" ? { input: { image_urls: ordered } } : { image_urls: ordered },
			);
		}
	},
);

test("live edit rejects unsupported attempts, output controls, and reference shapes", () => {
	const remote = editDraft.references[0];
	const file = { kind: "file", file: { name: "local.png", size: 90, type: "image/png" } };
	for (const overrides of [
		{ count: 0 },
		{ count: 6 },
		{ count: 2.2 },
		{ count: "1" },
		{ retryLimit: -1 },
		{ retryLimit: 4 },
		{ retryLimit: "0" },
		{ editDisclosure: ["forged terms"] },
		{ draft: { ...editDraft, layer_decomposition: true } },
		{ draft: { ...editDraft, options: { ...editDraft.options, layer_decomposition: true } } },
	]) {
		expect(parseQueueRequest({ ...request, draft: editDraft, ...overrides })).toBeNull();
	}
	for (const references of [
		[],
		[remote, { ...remote, url: editUrl }],
		Array.from({ length: 11 }, (_, index) => ({ ...remote, url: `${editUrl}-${index}` })),
		[file],
		[remote, file],
		[remote, { ...remote, url: "not a URL" }],
		[remote, { ...remote, name: "private annotation" }],
		[null],
		[{ url: editUrl }],
		[{ ...remote, url: 3 }],
		[{ ...remote, hostname: true }],
		[{ ...remote, file }],
		{ 0: remote, length: 1 },
	]) {
		expect(parseQueueRequest({ ...request, draft: { ...editDraft, references } })).toBeNull();
	}
});

test.each([
	"/image.png",
	"ftp://images.example.org/image.png",
	"https://user:password@images.example.org/image.png",
	"https://printer.local/image.png",
	"http://127.1/image.png",
	"http://169.254.169.254/image.png",
	"http://[::1]/image.png",
])("live edit rejects %s even with a supplied public hostname", (url) => {
	const references = [{ kind: "url", url, hostname: "images.example.org" }];
	expect(parseQueueRequest({ ...request, draft: { ...editDraft, references } })).toBeNull();
});

test.each(["poyo", "toapis"] as const)(
	"resolve %s catalog keys exactly before accepting ordinary options",
	(provider) => {
		const route = provider === "poyo" ? "POST /api/generate/submit" : "POST /v1/images/generations";
		const model = provider === "poyo" ? "seedream-5.5" : "doubao-seedream-5-5";
		for (const current of [draft, editDraft]) {
			const operationKey = {
				provider,
				model,
				route,
				operation: current.operation === "generate" ? "text-to-image" : "reference-image-edit",
			} as const;
			const input = { ...request, draft: { ...current, provider }, operationKey };
			const parsed = parseQueueRequest(input);
			expect(parsed?.entry.key).toEqual(operationKey);
			expect(parsed?.request).toEqual(
				parseQueueRequest({ ...request, draft: input.draft })?.request,
			);
			for (const key of [
				null,
				{},
				{ ...operationKey, provider: "other" },
				{ ...operationKey, model: model.toUpperCase() },
				{ ...operationKey, route: `${route}/` },
				{ ...operationKey, model: "seedream-5.5-layerize" },
				{ ...operationKey, operation: "image-layer-decomposition" },
				{
					...operationKey,
					operation: current.operation === "edit" ? "text-to-image" : "reference-image-edit",
				},
			]) {
				expect(parseQueueRequest({ ...input, operationKey: key })).toBeNull();
			}
			for (const field of ["layer_decomposition", "output_count", "image_urls"]) {
				expect(
					parseQueueRequest({
						...input,
						draft: { ...input.draft, options: { ...current.options, [field]: true } },
					}),
				).toBeNull();
			}
		}
	},
);
test("live Review accepts the maximum batch and preserves its explicit extra-attempt budget", () => {
	expect(parseQueueRequest({ ...request, count: 5, retryLimit: 3 })).toMatchObject({
		count: 5,
		retryLimit: 3,
	});
});
