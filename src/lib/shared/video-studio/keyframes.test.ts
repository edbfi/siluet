import { describe, expect, test } from "bun:test";
import { seedanceKeyframeOperations } from "../media-catalog/registry";
import { frameReviewLabels, frameUrlProblem, keyframeDisclosures, readFrames } from "./keyframes";
import { saveProfileDisclosure } from "./save-profile";

const [animate, interpolate] = seedanceKeyframeOperations;
const start = "https://cdn.example.com/a.png?X-Amz-Signature=start#crop";
const end = "https://cdn.example.com/b.png?X-Amz-Signature=end";

// A URL of exactly `size` UTF-8 bytes whose path ends in a four-byte character.
const sized = (size: number) => {
	const head = "https://cdn.example.com/";
	return `${head}${"a".repeat(size - head.length - 4)}🌲`;
};

describe("frame slots", () => {
	test("each operation takes its roles in order, trimmed, with query and fragment", () => {
		expect(readFrames(animate.roles, [{ role: "first_frame", url: ` ${start} ` }])).toEqual({
			frames: [{ role: "first_frame", url: start, hostname: "cdn.example.com" }],
		});
		expect(
			readFrames(interpolate.roles, [
				{ role: "first_frame", url: start },
				{ role: "last_frame", url: end },
			]),
		).toEqual({
			frames: [
				{ role: "first_frame", url: start, hostname: "cdn.example.com" },
				{ role: "last_frame", url: end, hostname: "cdn.example.com" },
			],
		});
	});

	test.each([
		["missing", interpolate.roles, [{ role: "first_frame", url: start }]],
		[
			"extra",
			animate.roles,
			[
				{ role: "first_frame", url: start },
				{ role: "last_frame", url: end },
			],
		],
		["last only", animate.roles, [{ role: "last_frame", url: end }]],
		[
			"swapped",
			interpolate.roles,
			[
				{ role: "last_frame", url: end },
				{ role: "first_frame", url: start },
			],
		],
		[
			"repeated",
			interpolate.roles,
			[
				{ role: "first_frame", url: start },
				{ role: "first_frame", url: end },
			],
		],
		[
			"duplicate after trimming",
			interpolate.roles,
			[
				{ role: "first_frame", url: start },
				{ role: "last_frame", url: ` ${start}` },
			],
		],
		["extra slot field", animate.roles, [{ role: "first_frame", url: start, kind: "url" }]],
		["not a list", animate.roles, { role: "first_frame", url: start }],
		["non-string URL", animate.roles, [{ role: "first_frame", url: 1 }]],
	])("%s slots are refused", (_, roles, slots) => {
		expect(readFrames(roles, slots)).toHaveProperty("error");
	});
});

describe("frame URLs", () => {
	test.each([
		["credentials", "https://user:pass@cdn.example.com/a.png"],
		["loopback", "http://127.0.0.1/a.png"],
		["private range", "https://10.0.0.4/a.png"],
		["local name", "https://studio.local/a.png"],
		["data URL", "data:image/png;base64,AAAA"],
		["asset ID", "asset://character-1"],
		["empty", "  "],
	])("%s is refused", (_, url) => {
		expect(frameUrlProblem("first_frame", url)).toBeString();
	});

	test("2,048 UTF-8 bytes are accepted and 2,049 refused", () => {
		const fits = sized(2048);
		expect(fits.length).toBeLessThan(2048);
		expect(frameUrlProblem("last_frame", fits)).toBeNull();
		expect(frameUrlProblem("last_frame", sized(2049))).toBe(
			"Ending frame exceeds 2,048 UTF-8 bytes.",
		);
	});
});

test("Review labels name the role and host, never the URL", () => {
	const labels = frameReviewLabels([
		{ role: "first_frame", url: start, hostname: "cdn.example.com" },
		{ role: "last_frame", url: end, hostname: "cdn.example.com" },
	]);
	expect(labels).toEqual(["Starting frame · cdn.example.com", "Ending frame · cdn.example.com"]);
});

test("keyframe disclosures are static and end with the Gallery Save profile", () => {
	expect(keyframeDisclosures).toHaveLength(5);
	expect(keyframeDisclosures.at(-1)).toBe(saveProfileDisclosure);
	expect(keyframeDisclosures.join(" ")).not.toContain("cdn.example.com");
	expect(keyframeDisclosures[1]).toContain("20 minutes per round by default");
});
