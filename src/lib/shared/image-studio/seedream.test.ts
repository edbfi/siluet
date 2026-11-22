import { expect, test } from "bun:test";
import { parseReferenceUrl, referenceFileError } from "./references";
import {
	buildSeedreamRequest,
	createSeedreamDraft,
	switchSeedreamDraft,
	validateSeedreamDraft,
} from "./seedream";

const prompt = "Blend the two references on a transparent background.";
const remoteUrl = "https://images.example.com/private/ref?signature=fixture";

function remoteReference() {
	const reference = parseReferenceUrl(remoteUrl);
	if (!reference) throw new Error("Expected a valid reference URL");
	return reference;
}

test("Poyo.ai requests one text-to-image generation with nested options and no references", () => {
	// https://docs.poyo.ai/api-manual/image-series/seedream-5-5
	const draft = createSeedreamDraft("poyo");
	draft.prompt = ` ${prompt} `;
	draft.options.aspectRatio = "21:9";
	draft.options.resolution = "1.5K";
	draft.options.background = "opaque";
	draft.options.outputFormat = "jpeg";

	const result = validateSeedreamDraft(draft);
	expect(result.ok).toBe(true);
	if (!result.ok) throw new Error("Expected a valid Poyo.ai request");
	expect(buildSeedreamRequest(result.input, () => "[reference]")).toEqual({
		method: "POST",
		url: "https://api.poyo.ai/api/generate/submit",
		body: {
			model: "seedream-5.5",
			input: {
				prompt,
				size: "21:9",
				resolution: "1.5K",
				background: "opaque",
				output_format: "jpeg",
				enable_safety_checker: false,
			},
		},
	});
});

test("Poyo.ai edits use automatic framing and keep mixed references in order", () => {
	const draft = createSeedreamDraft("poyo", "edit");
	draft.prompt = prompt;
	draft.references = [
		remoteReference(),
		{ kind: "file", file: new File(["image"], "front.png", { type: "image/png" }) },
	];
	const result = validateSeedreamDraft(draft);
	if (!result.ok) throw new Error("Expected a valid Poyo.ai edit");
	expect(result.input.references).toEqual(draft.references);
	expect(
		buildSeedreamRequest(result.input, (reference) =>
			reference.kind === "url" ? reference.url : "[local upload]",
		).body,
	).toEqual({
		model: "seedream-5.5",
		input: {
			prompt,
			size: "auto",
			resolution: "2K",
			background: "auto",
			output_format: "png",
			enable_safety_checker: false,
			image_urls: [remoteUrl, "[local upload]"],
		},
	});
});

test("ToAPIs maps exact dimensions and watermark for one edit with top-level references", () => {
	// https://docs.toapis.com/docs/en/api-reference/images/seedream-5.5/generation
	const draft = createSeedreamDraft("toapis", "edit");
	draft.prompt = prompt;
	draft.options.sizeMode = "pixels";
	draft.options.width = 2560;
	draft.options.height = 1440;
	draft.options.background = "transparent";
	draft.options.watermark = true;
	draft.references = [remoteReference()];

	const result = validateSeedreamDraft(draft);
	if (!result.ok) throw new Error("Expected a valid ToAPIs edit");
	expect(buildSeedreamRequest(result.input, () => "[remote URL]")).toEqual({
		method: "POST",
		url: "https://toapis.com/v1/images/generations",
		body: {
			model: "doubao-seedream-5-5",
			prompt,
			size: "2560x1440",
			disable_nsfw: false,
			metadata: { background: "transparent", output_format: "png", watermark: true },
			image_urls: ["[remote URL]"],
		},
	});
});

test("ToAPIs generation uses the selected tier and omits edit-only fields", () => {
	const draft = createSeedreamDraft("toapis");
	draft.prompt = "A";
	draft.options.resolution = "1K";
	const result = validateSeedreamDraft(draft);
	if (!result.ok) throw new Error("Expected a valid ToAPIs generation");
	expect(
		buildSeedreamRequest(result.input, () => {
			throw new Error("Unexpected reference");
		}).body,
	).toEqual({
		model: "doubao-seedream-5-5",
		prompt: "A",
		size: "1K",
		disable_nsfw: false,
		metadata: { background: "auto", output_format: "png", watermark: false },
	});
});

test("provider and operation switches clear media, default their options and retain the prompt", () => {
	const draft = createSeedreamDraft("toapis", "edit");
	draft.prompt = prompt;
	draft.options.watermark = true;
	draft.references = [remoteReference()];

	const poyo = switchSeedreamDraft(draft, "poyo");
	expect(poyo).toMatchObject({
		provider: "poyo",
		operation: "edit",
		prompt,
		references: [],
		options: { aspectRatio: "auto", watermark: false },
	});
	expect(validateSeedreamDraft(poyo)).toMatchObject({
		ok: false,
		errors: { references: expect.any(String) },
	});
	const generation = switchSeedreamDraft(poyo, "poyo", "generate");
	expect(generation).toMatchObject({
		operation: "generate",
		prompt,
		references: [],
		options: { aspectRatio: "1:1" },
	});
	expect(validateSeedreamDraft(generation, ["toapis"])).toMatchObject({
		ok: false,
		errors: { provider: expect.any(String) },
	});
});

test("draft validation catches out-of-range prompts, generation auto framing and transparent JPEG", () => {
	const draft = createSeedreamDraft("poyo");
	draft.prompt = "four";
	draft.options.aspectRatio = "auto";
	draft.options.background = "transparent";
	draft.options.outputFormat = "jpeg";

	expect(validateSeedreamDraft(draft)).toMatchObject({
		ok: false,
		errors: {
			prompt: expect.any(String),
			size: expect.any(String),
			outputFormat: expect.any(String),
		},
	});
	draft.prompt = "é".repeat(5001);
	expect(validateSeedreamDraft(draft)).toMatchObject({
		ok: false,
		errors: { prompt: expect.any(String) },
	});
	draft.prompt = "🙂".repeat(5000);
	draft.options.aspectRatio = "1:1";
	draft.options.outputFormat = "png";
	expect(validateSeedreamDraft(draft).ok).toBe(true);
});

test("Poyo.ai counts Unicode code points at the inclusive prompt boundaries", () => {
	const draft = createSeedreamDraft("poyo");
	draft.prompt = "🛶".repeat(4);
	expect(validateSeedreamDraft(draft).ok).toBe(false);
	draft.prompt = "🛶".repeat(5);
	expect(validateSeedreamDraft(draft).ok).toBe(true);
	draft.prompt = "🛶".repeat(5000);
	expect(validateSeedreamDraft(draft).ok).toBe(true);
	draft.prompt += "🛶";
	expect(validateSeedreamDraft(draft).ok).toBe(false);
});

test.each([
	[1280, 720, true],
	[2210, 2092, true],
	[3840, 240, true],
	[3841, 240, false],
	[1280, 719, false],
	[2210, 2093, false],
	[1280.5, 720, false],
	[undefined, 1080, false],
])("ToAPIs dimensions %s×%s have validity %s", (width, height, valid) => {
	const draft = createSeedreamDraft("toapis");
	draft.prompt = prompt;
	Object.assign(draft.options, { sizeMode: "pixels", width, height });
	expect(validateSeedreamDraft(draft).ok).toBe(valid);
});

test("edits require one to ten references and reject invalid staged references", () => {
	const draft = createSeedreamDraft("poyo", "edit");
	draft.prompt = prompt;
	expect(validateSeedreamDraft(draft)).toMatchObject({
		ok: false,
		errors: { references: expect.any(String) },
	});
	draft.references = Array.from({ length: 10 }, remoteReference);
	expect(validateSeedreamDraft(draft).ok).toBe(true);
	draft.references = [...draft.references, remoteReference()];
	expect(validateSeedreamDraft(draft)).toMatchObject({
		ok: false,
		errors: { references: expect.any(String) },
	});
	draft.references = [
		{ kind: "url", hostname: "images.example.com", url: "http://127.0.0.1/a.jpg" },
	];
	expect(validateSeedreamDraft(draft)).toMatchObject({
		ok: false,
		errors: { references: expect.any(String) },
	});
});

test("a review input retains its validated prompt and ordered references as the draft changes", () => {
	const draft = createSeedreamDraft("poyo", "edit");
	draft.prompt = prompt;
	draft.references = [remoteReference()];
	const result = validateSeedreamDraft(draft);
	if (!result.ok) throw new Error("Expected a valid Poyo.ai edit");

	draft.prompt = "A different prompt";
	draft.references.splice(0, 1);
	expect(result.input.prompt).toBe(prompt);
	expect(result.input.references).toEqual([remoteReference()]);
});

test("reference URL validation preserves signed paths, identifies the host and rejects private addresses", () => {
	expect(parseReferenceUrl(`  ${remoteUrl}  `)).toEqual({
		kind: "url",
		url: remoteUrl,
		hostname: "images.example.com",
	});
	expect(parseReferenceUrl("http://images.example.com/image")).not.toBeNull();
	expect(parseReferenceUrl("http://[2606:4700::1]/image")).not.toBeNull();
	for (const value of [
		"data:image/png;base64,AA==",
		"ftp://images.example.com/image",
		"https:images.example.com/image",
		"https:///images.example.com/image",
		"http://user:pass@images.example.com/image",
		"http://localhost/image",
		"http://images.example.test/image",
		"http://printer.service.arpa/image",
		"http://SERVICE.ARPA./image",
		"http://assets.invalid/image",
		"http://fixture.example/image",
		"http://site.onion/image",
		"http://media.alt/image",
		"http://ipv4only.arpa/image",
		"http://resolver.arpa/image",
		"http://dns.RESOLVER.ARPA./image",
		"http://1.0.0.127.in-addr.arpa/image",
		"http://home.arpa/image",
		"http://192.88.99.2/image",
		"http://127.1/image",
		"http://192.168.1.1/image",
		"http://169.254.169.254/image",
		"http://[::1]/image",
		"http://[2::1]/image",
		"http://[03ff::1]/image",
		"http://[::ffff:7f00:1]/image",
		"http://[fc00::1]/image",
	])
		expect(parseReferenceUrl(value)).toBeNull();
});

// https://www.iana.org/assignments/iana-ipv6-special-registry
// https://www.iana.org/assignments/ipv6-unicast-address-assignments
test.each([
	"2001:2::1",
	"2001:1::4",
	"2001:10::1",
	"2001::1",
	"2001:db8::1",
	"2002:c000:201::1",
	"3ffe::1",
	"3fff:fff::1",
	"2fff::1",
	"2001:1000::1",
	"2003:4000::1",
	"2610:200::1",
	"64:ff9b::7f00:1",
])("rejects non-public IPv6 literal %s", (address) => {
	expect(parseReferenceUrl(`https://[${address}]/image`)).toBeNull();
});

test.each([
	"2001:1::3",
	"2001:3::1",
	"2001:4:112::1",
	"2001:2f::1",
	"2001:30::1",
	"2001:200::1",
	"2001:4860:4860::8888",
	"2003:3fff::1",
	"2410::1",
	"2606:4700::1",
	"2610:1ff::1",
	"2620:4f:8000::1",
	"2c0f:ffff::1",
])("accepts eligible public IPv6 literal %s", (address) => {
	expect(parseReferenceUrl(`https://[${address}]/image`)).toMatchObject({
		hostname: `[${address}]`,
	});
});

test("reference file validation applies each provider’s formats and decimal byte cap", () => {
	// https://docs.poyo.ai/api-manual/image-series/seedream-5-5
	// https://docs.toapis.com/docs/en/api-reference/images/seedream-5.5/generation
	// https://docs.toapis.com/docs/en/api-reference/uploads/images
	const webp = { name: "REF.WEBP", type: "", size: 10_000_000 };
	expect(referenceFileError("poyo", webp)).toBeNull();
	expect(referenceFileError("poyo", { ...webp, size: 10_000_001 })).toMatch(/10 MB/);
	expect(referenceFileError("toapis", { ...webp, size: 30_000_000 })).toBeNull();
	expect(referenceFileError("toapis", { ...webp, size: 30_000_001 })).toMatch(/30 MB/);
	expect(referenceFileError("poyo", { ...webp, type: "image/gif" })).toBe(
		"Choose a non-empty image. Supported files are JPEG or PNG up to 16 MiB, or WebP up to 10 MB.",
	);
	expect(referenceFileError("toapis", { ...webp, name: "ref.gif", type: "image/gif" })).toBeNull();
	expect(referenceFileError("toapis", { ...webp, type: "image/svg+xml" })).not.toBeNull();
	expect(referenceFileError("poyo", { ...webp, size: 0 })).not.toBeNull();
});
