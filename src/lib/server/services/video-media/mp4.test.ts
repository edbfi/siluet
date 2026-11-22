import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { inspectMp4 } from "./mp4";

const source = readFileSync("src/lib/server/services/video-media/qualification.mp4");
test("counts stored samples for each track, including AAC encoder priming", () => {
	expect(inspectMp4(source)).toEqual([
		{ type: "video", samples: 24 },
		{ type: "audio", samples: 95 },
	]);
});
test("refuses trailing bytes, incomplete chunk maps, external references and timing disagreement", () => {
	expect(() => inspectMp4(Buffer.concat([source, Buffer.alloc(2)]))).toThrow();
	for (const [box, offset, value] of [
		["stts", 12, 25],
		["stco", 12, 0],
		["url ", 4, 0],
		["stsc", 12, 2],
	] as const) {
		const bytes = Buffer.from(source);
		bytes.writeUInt32BE(value, bytes.indexOf(box) + offset);
		expect(() => inspectMp4(bytes)).toThrow();
	}
});
