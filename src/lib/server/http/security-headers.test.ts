import { expect, test } from "bun:test";
import type { FileHandle } from "node:fs/promises";
import { videoResponse } from "../services/gallery/video-response";
import { privateMediaResponse } from "../services/media/private-response";
import {
	imagePolicy,
	mediaHeaders,
	responsePolicy,
	videoPolicy,
	withSecurityHeaders,
} from "./security-headers";

const baseline = {
	"x-frame-options": "DENY",
	"x-content-type-options": "nosniff",
	"referrer-policy": "same-origin",
};

test("a response without its own policy gains the baseline headers and a no-content policy", () => {
	const response = withSecurityHeaders(new Response("text", { headers: { "cache-control": "x" } }));
	expect(Object.fromEntries(response.headers)).toMatchObject({
		...baseline,
		"cache-control": "x",
		"content-security-policy": responsePolicy,
	});
	expect(responsePolicy).toContain("default-src 'none'");
	expect(responsePolicy).toContain("frame-ancestors 'none'");
});

test("a page or media policy is kept, and redirects keep their location", () => {
	const page = "default-src 'self'; frame-ancestors 'none'";
	expect(
		withSecurityHeaders(
			new Response("", { headers: { "content-security-policy": page } }),
		).headers.get("content-security-policy"),
	).toBe(page);
	const moved = withSecurityHeaders(
		new Response(null, { status: 303, headers: { location: "/setup" } }),
	);
	expect(moved.status).toBe(303);
	expect(Object.fromEntries(moved.headers)).toMatchObject({ ...baseline, location: "/setup" });
});

test("saved and staged media are sandboxed, unframeable, script-free documents", () => {
	for (const policy of [imagePolicy, videoPolicy]) {
		expect(policy).toContain("default-src 'none'");
		expect(policy).toContain("frame-ancestors 'none'");
		expect(policy).not.toContain("script-src");
		expect(policy).not.toContain("allow-scripts");
	}
	expect(imagePolicy).toMatch(/; sandbox$/);
	expect(imagePolicy).not.toContain("media-src");
	expect(videoPolicy).toMatch(/; sandbox allow-same-origin$/);
	expect(videoPolicy).toContain("media-src 'self'");
});

test("staged previews and saved videos send the media headers, including on HEAD and 416", async () => {
	const handle = () => ({
		read: async () => ({ bytesRead: 0 }),
		close: async () => {},
	});
	const url = new URL("http://127.0.0.1/media");
	const images = [
		await privateMediaResponse(new Request(url, { method: "HEAD" }), {
			handle: handle(),
			size: 4,
			mime: "image/png",
		}),
		await privateMediaResponse(new Request(url, { headers: { range: "bytes=9-" } }), {
			handle: handle(),
			size: 4,
			mime: "image/jpeg",
		}),
	];
	const videos = [
		await videoResponse(
			new Request(url, { method: "HEAD" }),
			url,
			{ handle: handle() as unknown as FileHandle, size: 4 },
			"clip.mp4",
		),
		await videoResponse(
			new Request(url, { headers: { range: "bytes=9-" } }),
			url,
			{ handle: handle() as unknown as FileHandle, size: 4 },
			"clip.mp4",
		),
	];
	for (const [kind, responses] of [
		["image", images],
		["video", videos],
	] as const)
		for (const response of responses)
			for (const [name, value] of Object.entries(mediaHeaders(kind)))
				expect(response.headers.get(name)).toBe(value);
});
