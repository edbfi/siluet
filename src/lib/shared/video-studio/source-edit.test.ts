import { expect, test } from "bun:test";
import { seedanceEditOperation } from "../media-catalog/registry";
import { frameReviewLabels, frameUrlProblem, readFrames, roleMedia } from "./keyframes";
import { editAcceptance, editDisclosures, sourceClipHint } from "./source-edit";

const source = "https://media.example.com/clips/take-3.mp4?X-Amz-Signature=abc#t=2";

test("the source slot is one trimmed public URL with its query and fragment", () => {
	expect(
		readFrames(seedanceEditOperation.roles, [{ role: "reference_video", url: ` ${source} ` }]),
	).toEqual({ frames: [{ role: "reference_video", url: source, hostname: "media.example.com" }] });
});

test.each([
	["no slot", []],
	[
		"two slots",
		[
			{ role: "reference_video", url: source },
			{ role: "reference_video", url: `${source}2` },
		],
	],
	["a frame role", [{ role: "first_frame", url: source }]],
	["an extra slot field", [{ role: "reference_video", url: source, kind: "url" }]],
])("%s is refused", (_, slots) => {
	expect(readFrames(seedanceEditOperation.roles, slots)).toHaveProperty("error");
});

test.each([
	["credentials", "https://user:pass@media.example.com/a.mp4"],
	["a private host", "https://192.168.1.20/a.mp4"],
	["a data URL", "data:video/mp4;base64,AAAA"],
	["an asset reference", "asset://clip-1"],
])("a source with %s is refused", (_, url) => {
	expect(frameUrlProblem("reference_video", url)).toBeString();
});

test("a 2,048-byte multibyte source is accepted and 2,049 bytes are refused", () => {
	const head = "https://media.example.com/";
	const sized = (size: number) => `${head}${"a".repeat(size - head.length - 4)}🌲`;
	expect(frameUrlProblem("reference_video", sized(2048))).toBeNull();
	expect(frameUrlProblem("reference_video", sized(2049))).toBe(
		"Source clip exceeds 2,048 UTF-8 bytes.",
	);
});

test("the Review label names the host without path, query or fragment", () => {
	const [label] = frameReviewLabels([
		{ role: "reference_video", url: source, hostname: "media.example.com" },
	]);
	expect(label).toBe("Source clip · media.example.com");
	for (const part of ["clips", "take-3", "X-Amz-Signature", "#t"])
		expect(label).not.toContain(part);
});

test("roles map to the media kind the estimator prices", () => {
	expect(roleMedia("reference_video")).toBe("video");
	expect(roleMedia("first_frame")).toBe("image");
	expect(roleMedia("last_frame")).toBe("image");
});

test("edit Review discloses the source, asset review, limits, length and charges, leaving the Save limit to Review", () => {
	expect(editDisclosures).toHaveLength(5);
	expect(editDisclosures[0]).toContain("complete source-clip URL, including any signed query");
	expect(editDisclosures[0]).toContain("API call logs for 90 days by default");
	expect(editDisclosures[1]).toContain("20 minutes per round by default");
	expect(editDisclosures[2]).toContain("up to 100 MiB");
	expect(editDisclosures[3]).toBe(
		"The edit lasts about as long as the source, which Siluet does not measure. A source longer than 30 seconds can be charged for an edit Gallery may not save; Gallery allows the returned clip up to 1 second over its limit for container rounding. A longer source makes a longer, costlier edit.",
	);
	expect(editDisclosures[4]).toContain("whether the source soundtrack stays when audio is off");
	expect(editAcceptance).toBe(
		"I accept the unknown charge, sending the complete source-clip URL to ToAPIs and its processors under their access and retention terms, and Gallery Save limitations, including that a source longer than 30 seconds can be charged for an edit Gallery may not save; Gallery allows the returned clip up to 1 second over its limit for container rounding.",
	);
	for (const text of [sourceClipHint, editAcceptance, ...editDisclosures])
		expect(text).not.toMatch(/12.second|cannot save an edit/);
	expect(sourceClipHint).toBe(
		"Public HTTP or HTTPS video URL, up to 2,048 UTF-8 bytes. Siluet does not open, check or clean it before sending it to ToAPIs. A source longer than 30 seconds can be charged for an edit Gallery may not save; Gallery allows the returned clip up to 1 second over its limit for container rounding.",
	);
});
