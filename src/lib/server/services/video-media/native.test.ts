import { expect, test } from "bun:test";
import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { qualifiedVerifier, verifyVideo } from "./native";

const qualification = "src/lib/server/services/video-media/qualification.mp4";
const silent = "tests/fixtures/video/silent.mp4";
const configured = process.env.SILUET_FFMPEG_DIR;
test("an unqualified installation keeps native verification unavailable", async () => {
	expect(await qualifiedVerifier("/missing")).toBeNull();
});
test.skipIf(!configured)(
	"the configured native build accounts for all stored video and AAC samples, including those outside the edit",
	async () => {
		const verifier = await qualifiedVerifier(configured);
		if (!verifier) throw new Error("Configured native build did not qualify.");
		for (const path of [qualification, silent])
			expect(await verifyVideo(path, verifier)).toEqual({
				mime: "video/mp4",
				width: 96,
				height: 64,
				duration: 2,
			});
		const directory = await mkdtemp(join(tmpdir(), "siluet-native-"));
		try {
			const path = join(directory, "sample.mp4");
			const bytes = await readFile(silent);
			const scale = bytes.readUInt32BE(bytes.indexOf("mvhd") + 16);
			for (const [box, field] of [
				["mvhd", 20],
				["tkhd", 24],
				["elst", 12],
			] as const)
				bytes.writeUInt32BE(scale, bytes.indexOf(box) + field);
			await writeFile(path, bytes);
			expect((await verifyVideo(path, verifier)).duration).toBe(1);
			const short = Buffer.from(bytes);
			short.writeUInt32BE(23, short.indexOf("stsc") + 16);
			await writeFile(path, short);
			const demux = await promisify(execFile)(verifier.ffprobe, [
				"-v",
				"error",
				"-f",
				"mov",
				"-ignore_editlist",
				"1",
				"-count_packets",
				"-show_entries",
				"stream=nb_read_packets",
				"-of",
				"csv=p=0",
				path,
			]);
			expect(demux.stdout.trim()).toBe("23");
			await expect(verifyVideo(path, verifier)).rejects.toThrow();
			// The silent synthetic clip has one mdat and one chunk. Damage only the last stored frame.
			const sizes = bytes.indexOf("stsz") + 16;
			const last = bytes.readUInt32BE(sizes + 23 * 4);
			bytes.fill(0, bytes.length - last);
			await writeFile(path, bytes);
			await expect(verifyVideo(path, verifier)).rejects.toThrow();
			// The last muxed packet of the two-track fixture belongs to AAC.
			const audio = await readFile(qualification);
			audio.fill(0xff, audio.length - 5);
			await writeFile(path, audio);
			await expect(verifyVideo(path, verifier)).rejects.toThrow();
		} finally {
			await rm(directory, { recursive: true, force: true });
		}
	},
	20000,
);

test.skipIf(!configured)(
	"qualifies a 720p clip and refuses unsupported encodings, tracks, rate, frame count and presentation length",
	async () => {
		const verifier = await qualifiedVerifier(configured);
		if (!verifier) throw new Error("Configured native build did not qualify.");
		const dir = await mkdtemp(join(tmpdir(), "siluet-codecs-"));
		try {
			const path = join(dir, "clip.mp4");
			const encode = async (source: string, options: string[], audio = false) => {
				await promisify(execFile)(verifier.ffmpeg, [
					"-nostdin",
					"-v",
					"error",
					"-y",
					"-f",
					"lavfi",
					"-i",
					source,
					...(audio ? ["-f", "lavfi", "-i", "sine=sample_rate=96000:duration=0.25"] : []),
					"-c:v",
					"libx264",
					"-pix_fmt",
					"yuv420p",
					"-threads",
					"1",
					...options,
					path,
				]);
			};
			await encode("color=s=1280x720:d=4:r=24", []);
			expect(await verifyVideo(path, verifier)).toMatchObject({
				width: 1280,
				height: 720,
				duration: 4,
			});
			await expect(verifyVideo(path, verifier, 5)).rejects.toThrow();
			for (const [filter, options, audio] of [
				["color=s=32x32:d=1", ["-c:v", "mpeg4"], false],
				["color=s=32x32:d=1", ["-movflags", "frag_keyframe+empty_moov"], false],
				["color=s=32x32:d=1", ["-map", "0:v", "-map", "0:v"], false],
				[
					"color=s=32x32:d=1",
					["-x264-params", "colorprim=bt2020:transfer=smpte2084:colormatrix=bt2020nc"],
					false,
				],
				[
					"color=s=32x32:d=1",
					["-x264-params", "colorprim=bt2020:transfer=arib-std-b67:colormatrix=bt2020nc"],
					false,
				],
				["color=s=32x32:d=1", ["-pix_fmt", "yuv420p10le"], false],
				["color=s=2048x32:d=1", [], false],
				["color=s=32x32:d=13:r=2", [], false],
				["color=s=16x16:d=10:r=73", [], false],
				["color=s=32x32:d=1", ["-c:a", "aac"], true],
			] as [string, string[], boolean][]) {
				await encode(filter, options, audio);
				await expect(
					verifyVideo(path, verifier),
					JSON.stringify([filter, options, audio]),
				).rejects.toThrow();
			}
		} finally {
			await rm(dir, { recursive: true, force: true });
		}
	},
	45000,
);
