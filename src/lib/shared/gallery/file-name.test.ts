import { expect, test } from "bun:test";
import { mediaFileName } from "./file-name";

test("download names come from the job's short ID and its saved type", () => {
	expect(mediaFileName("0123abcd-ef", "image/png")).toBe("siluet-image-0123abcd.png");
	expect(mediaFileName("0123abcd-ef", "image/jpeg")).toBe("siluet-image-0123abcd.jpg");
	expect(mediaFileName("0123abcd-ef", "video/mp4")).toBe("siluet-video-0123abcd.mp4");
	expect(mediaFileName('a"b/c\\d', "image/png")).toBe("siluet-image-abcd.png");
});
