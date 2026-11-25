import { describe, expect, test } from "bun:test";
import {
	h3MaxOperation,
	seedanceEditOperation,
	seedanceKeyframeOperations,
	seedanceOperation,
} from "../media-catalog/registry";
import { h3Max } from "./h3-max";
import { keyframeDisclosures } from "./keyframes";
import { parseVideo, previewVideo, videoReviewDisclosures } from "./request";
import { saveDisclosure } from "./save-profile";
import { videoDefaults, videoDisclosures } from "./seedance";
import { editDisclosures } from "./source-edit";

const draft = {
	prompt: "  A lake at https://private.test/secret ",
	duration: 5,
	resolution: "768p",
	aspect_ratio: "16:9",
} as const;
const raw = {
	draft,
	operationKey: h3MaxOperation.key,
	count: 1,
	retryLimit: 0,
	acceptTerms: false,
};

test("H3 golden default body", () => {
	const input = parseVideo({ ...raw, draft: { ...h3Max.defaults, prompt: "A paper boat." } });
	expect(input?.operation).toBe(h3MaxOperation);
	expect(input?.body).toEqual({
		model: "h3-max",
		input: {
			prompt: "A paper boat.",
			duration: 5,
			resolution: "768p",
			aspect_ratio: "16:9",
			enable_safety_checker: false,
		},
	});
	expect(input?.disclosures).toEqual([...h3Max.disclosures, savesUpTo(15)]);
	const redacted = parseVideo(raw);
	if (!redacted) throw Error("Missing parsed fixture");
	expect(JSON.stringify(previewVideo(redacted))).not.toContain("private.test");
});

const savesUpTo = (seconds: number) =>
	`Gallery saves complete H.264/AAC MP4 files up to ${seconds} seconds, the provider's documented maximum for this mode, plus 1 second for container rounding, within its size and dimension limits. A completed billable clip outside them stays with the provider.`;
const editSavesUpTo30 =
	"Gallery saves complete H.264/AAC MP4 files up to 30 seconds, the upstream model's documented maximum for this mode, unverified on this route, plus 1 second for container rounding, within its size and dimension limits. A completed billable clip outside them stays with the provider.";

test("each released mode states its own limit", () => {
	const seedance = { ...videoDefaults, prompt: "Drift" };
	const frames = [
		{ role: "first_frame", url: "https://cdn.example.com/start.png" },
		{ role: "last_frame", url: "https://cdn.example.com/end.png" },
	];
	const keyframe = { prompt: "Drift", duration: 5, resolution: "480p", generate_audio: false };
	const [animate, interpolate] = seedanceKeyframeOperations;
	const modes = [
		[seedanceOperation, seedance],
		[animate, { ...keyframe, frames: frames.slice(0, 1) }],
		[interpolate, { ...keyframe, frames }],
		[
			seedanceEditOperation,
			{
				prompt: "Drift",
				resolution: "720p",
				generate_audio: true,
				frames: [{ role: "reference_video", url: "https://cdn.example.com/take.mp4" }],
			},
		],
		[h3MaxOperation, { ...h3Max.defaults, prompt: "Drift" }],
	] as const;
	expect(
		modes.map(([operation, draft]) =>
			parseVideo({ ...raw, operationKey: operation.key, draft })?.disclosures.at(-1),
		),
	).toEqual([savesUpTo(30), savesUpTo(30), savesUpTo(30), editSavesUpTo30, savesUpTo(15)]);
});

test("Review picks an operation's disclosures by its mode, not its role count", () => {
	const [animate] = seedanceKeyframeOperations;
	expect(animate.roles).toHaveLength(seedanceEditOperation.roles.length);
	expect(videoReviewDisclosures(seedanceEditOperation)).toEqual([
		...editDisclosures,
		editSavesUpTo30,
	]);
	expect(videoReviewDisclosures(animate)).toEqual([...keyframeDisclosures, savesUpTo(30)]);
	expect(videoReviewDisclosures(seedanceOperation).slice(0, -1)).toEqual([...videoDisclosures]);
});

test("an upstream basis says unverified on this route, and no limit states none", () => {
	expect(saveDisclosure({ save: { seconds: 30, basis: "upstream" } })).toBe(
		"Gallery saves complete H.264/AAC MP4 files up to 30 seconds, the upstream model's documented maximum for this mode, unverified on this route, plus 1 second for container rounding, within its size and dimension limits. A completed billable clip outside them stays with the provider.",
	);
	expect(saveDisclosure({ save: null })).toBeNull();
});

describe("H3 input boundaries", () => {
	const bytes = (count: number) => `${"a".repeat(count - 4)}🌲`;
	test.each([
		[{ duration: 5 }, true],
		[{ duration: 10 }, true],
		[{ duration: 4 }, false],
		[{ duration: 11 }, false],
		[{ duration: 5.5 }, false],
		[{ duration: "5" }, false],
		[{ resolution: "480p" }, true],
		[{ resolution: "1080p" }, false],
		[{ aspect_ratio: "21:9" }, true],
		[{ aspect_ratio: "4:3" }, true],
		[{ aspect_ratio: "1:1" }, true],
		[{ aspect_ratio: "3:4" }, true],
		[{ aspect_ratio: "9:16" }, true],
		[{ aspect_ratio: "adaptive" }, false],
		[{ generate_audio: true }, false],
		[{ image_urls: [] }, false],
		[{ enable_safety_checker: false }, false],
		[{ callback_url: "https://example.test/" }, false],
		[{ prompt: bytes(4000) }, true],
		[{ prompt: bytes(4001) }, false],
		[{ prompt: "   " }, false],
	] as const)("%j accepted: %p", (change, accepted) => {
		const input = parseVideo({ ...raw, draft: { ...draft, ...change } });
		expect(input !== null).toBe(accepted);
		if (input && "input" in input.body) expect(input.body.input.enable_safety_checker).toBe(false);
	});

	test("missing fields and foreign operation keys are refused", () => {
		const { duration: _, ...partial } = draft;
		for (const invalid of [
			{ ...raw, draft: partial },
			{ ...raw, operationKey: { ...h3MaxOperation.key, provider: "toapis" } },
			{ ...raw, operationKey: { ...seedanceOperation.key, model: "MiniMax-H3-Max" } },
			{ ...raw, operationKey: seedanceOperation.key },
			...seedanceKeyframeOperations.map(({ key }) => ({
				...raw,
				operationKey: key,
				draft: { ...videoDefaults, prompt: "Rotate" },
			})),
			{ ...raw, count: 2 },
			{ ...raw, extra: true },
		])
			expect(parseVideo(invalid)).toBeNull();
	});
});

test("the Seedance request is unchanged by the provider dispatch", () => {
	const input = parseVideo({
		...raw,
		operationKey: seedanceOperation.key,
		draft: { ...videoDefaults, prompt: " Rotate " },
	});
	expect(input?.operation).toBe(seedanceOperation);
	expect(input?.body).toEqual({
		model: "seedance-2-5",
		prompt: "Rotate",
		video_operation: "generate",
		duration: 5,
		aspect_ratio: "16:9",
		resolution: "720p",
		generate_audio: true,
		output_format: "mp4",
		return_last_frame: false,
		disable_nsfw: false,
	});
	if (!input) throw Error("Missing parsed fixture");
	expect(previewVideo(input)).toMatchObject({
		client_business_id: "[Siluet assigns a correlation ID at Queue]",
	});
});

describe("Seedance keyframes", () => {
	const [animate, interpolate] = seedanceKeyframeOperations;
	const start = "https://cdn.example.com/a.png?X-Amz-Signature=start";
	const end = "https://cdn.example.com/b.png?X-Amz-Signature=end#t";
	const keyframeDraft = {
		prompt: " Drift ",
		duration: 6,
		resolution: "480p",
		generate_audio: false,
		frames: [
			{ role: "first_frame", url: start },
			{ role: "last_frame", url: ` ${end} ` },
		],
	};
	const keyframe = { ...raw, operationKey: interpolate.key, draft: keyframeDraft };
	const tail = {
		video_operation: "generate",
		duration: 6,
		aspect_ratio: "adaptive",
		resolution: "480p",
		generate_audio: false,
		output_format: "mp4",
		return_last_frame: false,
		disable_nsfw: false,
	};

	test("keyframe golden payloads", () => {
		const both = parseVideo(keyframe);
		expect(both?.operation).toBe(interpolate);
		expect(JSON.stringify(both?.body)).toBe(
			JSON.stringify({
				model: "seedance-2-5",
				prompt: "Drift",
				...tail,
				image_with_roles: [
					{ url: start, role: "first_frame" },
					{ url: end, role: "last_frame" },
				],
			}),
		);
		expect(both?.options).toEqual(tail);
		expect(both?.disclosures).toEqual([...keyframeDisclosures, savesUpTo(30)]);
		const one = parseVideo({
			...raw,
			operationKey: animate.key,
			draft: { ...keyframeDraft, frames: [keyframeDraft.frames[0]] },
		});
		expect(one?.operation).toBe(animate);
		expect(JSON.stringify(one?.body)).toBe(
			JSON.stringify({
				model: "seedance-2-5",
				prompt: "Drift",
				...tail,
				image_with_roles: [{ url: start, role: "first_frame" }],
			}),
		);
	});

	test.each([
		["an aspect ratio", { ...keyframeDraft, aspect_ratio: "adaptive" }],
		["no frames", { ...keyframeDraft, frames: undefined }],
		["an ending frame only", { ...keyframeDraft, frames: [keyframeDraft.frames[1]] }],
		[
			"a duplicate URL",
			{ ...keyframeDraft, frames: [keyframeDraft.frames[0], { role: "last_frame", url: start }] },
		],
		["image_urls", { ...keyframeDraft, image_urls: [start] }],
		["a 1080p resolution", { ...keyframeDraft, resolution: "1080p" }],
	])("a keyframe draft with %s is refused", (_, draft) => {
		expect(parseVideo({ ...keyframe, draft })).toBeNull();
	});

	test("text-to-video refuses frames", () => {
		expect(
			parseVideo({
				...raw,
				operationKey: seedanceOperation.key,
				draft: { ...videoDefaults, prompt: "Rotate", frames: keyframeDraft.frames },
			}),
		).toBeNull();
	});

	test("the preview shows frame labels in place of URLs and redacts the prompt", () => {
		const input = parseVideo({
			...keyframe,
			draft: { ...keyframeDraft, prompt: "Drift https://private.test/secret" },
		});
		if (!input) throw Error("Missing parsed fixture");
		const preview = previewVideo(input);
		expect(JSON.stringify(preview)).not.toContain("X-Amz-Signature");
		expect(JSON.stringify(preview)).not.toContain("private.test");
		expect(preview).toMatchObject({
			image_with_roles: [
				{ url: "Starting frame · cdn.example.com", role: "first_frame" },
				{ url: "Ending frame · cdn.example.com", role: "last_frame" },
			],
		});
	});
});

describe("Seedance source-video edit", () => {
	const source = "https://media.example.com/clips/take-3.mp4?X-Amz-Signature=abc#t=2";
	const editDraft = {
		prompt: " Make it dusk ",
		resolution: "720p",
		generate_audio: true,
		frames: [{ role: "reference_video", url: ` ${source} ` }],
	};
	const edit = { ...raw, operationKey: seedanceEditOperation.key, draft: editDraft };
	const options = {
		video_operation: "edit",
		duration: -1,
		aspect_ratio: "adaptive",
		resolution: "720p",
		generate_audio: true,
		output_format: "mp4",
		return_last_frame: false,
		disable_nsfw: false,
	};

	test("source-edit golden payload", () => {
		const input = parseVideo(edit);
		expect(input?.operation).toBe(seedanceEditOperation);
		expect(JSON.stringify(input?.body)).toBe(
			JSON.stringify({
				model: "seedance-2-5",
				prompt: "Make it dusk",
				...options,
				video_with_roles: [{ url: source, role: "reference_video" }],
			}),
		);
		expect(input?.options).toEqual(options);
		expect(input?.disclosures).toEqual([...editDisclosures, editSavesUpTo30]);
		expect(input?.body).not.toHaveProperty("image_with_roles");
		const low = parseVideo({
			...edit,
			draft: { ...editDraft, resolution: "480p", generate_audio: false },
		});
		expect(low?.options).toMatchObject({ resolution: "480p", generate_audio: false });
	});

	test.each([
		["a duration", { ...editDraft, duration: 5 }],
		["a forged duration", { ...editDraft, duration: -1 }],
		["an aspect ratio", { ...editDraft, aspect_ratio: "adaptive" }],
		["1080p", { ...editDraft, resolution: "1080p" }],
		["no source", { ...editDraft, frames: [] }],
		["a missing frames field", { ...editDraft, frames: undefined }],
		[
			"two sources",
			{
				...editDraft,
				frames: [
					{ role: "reference_video", url: source },
					{ role: "reference_video", url: `${source}x` },
				],
			},
		],
		["a frame role", { ...editDraft, frames: [{ role: "first_frame", url: source }] }],
		["image_with_roles", { ...editDraft, image_with_roles: [] }],
		["video_with_roles", { ...editDraft, video_with_roles: [] }],
		["a non-boolean audio flag", { ...editDraft, generate_audio: "true" }],
		[
			"a private host",
			{ ...editDraft, frames: [{ role: "reference_video", url: "http://10.0.0.2/a.mp4" }] },
		],
	])("an edit draft with %s is refused", (_, draft) => {
		expect(parseVideo({ ...edit, draft })).toBeNull();
	});

	test("reference_video on another operation is refused", () => {
		const slot = [{ role: "reference_video", url: source }];
		const [animate] = seedanceKeyframeOperations;
		expect(
			parseVideo({
				...raw,
				operationKey: animate.key,
				draft: { prompt: "x", duration: 5, resolution: "720p", generate_audio: true, frames: slot },
			}),
		).toBeNull();
		expect(
			parseVideo({
				...raw,
				operationKey: seedanceOperation.key,
				draft: { ...videoDefaults, prompt: "x", frames: slot },
			}),
		).toBeNull();
		expect(
			parseVideo({ ...edit, operationKey: { ...seedanceEditOperation.key, provider: "poyo" } }),
		).toBeNull();
	});

	test("the preview shows the source label in place of the URL and redacts the prompt", () => {
		const input = parseVideo({
			...edit,
			draft: { ...editDraft, prompt: "Dusk https://private.test/secret" },
		});
		if (!input) throw Error("Missing parsed fixture");
		const preview = JSON.stringify(previewVideo(input));
		for (const part of ["X-Amz-Signature", "take-3", "#t=2", "private.test"])
			expect(preview).not.toContain(part);
		expect(previewVideo(input)).toMatchObject({
			video_with_roles: [{ url: "Source clip · media.example.com", role: "reference_video" }],
		});
	});
});
