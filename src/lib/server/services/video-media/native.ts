import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { readFile, realpath, stat } from "node:fs/promises";
import { createRequire } from "node:module";
import { dirname, isAbsolute, join } from "node:path";
import { promisify } from "node:util";
import { videoByteLimit } from "./limits";
import { verifyVideoFile } from "./verify-video";

function ensure(condition: unknown): asserts condition {
	if (!condition) throw new Error("Unsupported video.");
}

type Verifier = { ffmpeg: string; ffprobe: string; identity: string };
const run = promisify(execFile);
const limit = "/usr/bin/prlimit";
const hashes = [
	"bb2e678f3167e7305d066deee3e7f6aef1c05aa4fcda86c186c1ad7b4e2a2289",
	"d24e9ababcb69f3059c90889e86ad7f3d915a4699c98af06cb0d17b2e10f0108",
];
async function runBounded(deadline: number, binary: string, args: string[]) {
	const timeout = Math.floor(deadline - performance.now());
	ensure(timeout > 0);
	try {
		const { stdout, stderr } = await run(
			"/usr/bin/setpriv",
			[
				"--pdeathsig",
				"KILL",
				"--no-new-privs",
				"--",
				limit,
				"--as=536870912:536870912",
				"--",
				binary,
				...args,
			],
			{
				timeout,
				killSignal: "SIGKILL",
				maxBuffer: 1024 * 1024,
				encoding: "utf8",
				env: { LC_ALL: "C", MALLOC_ARENA_MAX: "2" },
			},
		);
		ensure(!stderr && performance.now() <= deadline);
		return stdout;
	} catch {
		throw new Error("Unsupported video.");
	}
}

const qualified = new Map<string, Promise<Verifier | null>>();
export async function qualifiedVerifier(dir = process.env.SILUET_FFMPEG_DIR) {
	if (!dir || !isAbsolute(dir) || process.platform !== "linux" || process.arch !== "arm64")
		return null;
	try {
		const paths = await Promise.all(["ffmpeg", "ffprobe"].map((name) => realpath(join(dir, name))));
		const signatures = await Promise.all(
			[...paths, limit, "/usr/bin/setpriv"].map(async (path) => {
				const s = await stat(path, { bigint: true });
				ensure(s.isFile());
				return [path, String(s.dev), String(s.ino), String(s.ctimeNs)];
			}),
		);
		const identity = JSON.stringify(signatures);
		const cached = qualified.get(identity);
		if (cached) return cached;
		const check = (async () => {
			for (const [i, path] of paths.entries())
				ensure(
					createHash("sha256")
						.update(await readFile(path))
						.digest("hex") === hashes[i],
				);
			const measured = await runBounded(performance.now() + 5000, limit, [
				"--raw",
				"--noheadings",
				"--output",
				"SOFT,HARD",
				"--as",
			]);
			ensure(measured.trim() === "536870912 536870912");
			const verifier = {
				ffmpeg: paths[0],
				ffprobe: paths[1],
				identity: createHash("sha256").update(identity).digest("hex"),
			};
			const root = dirname(createRequire(import.meta.url).resolve("#studio-manifest"));
			await verifyVideo(
				join(
					root,
					import.meta.env?.PROD
						? "build/server/qualification.mp4"
						: "tests/fixtures/video/h264-aac.mp4",
				),
				verifier,
			);
			return verifier;
		})().catch(() => null);
		qualified.clear();
		qualified.set(identity, check);
		return await check;
	} catch {
		return null;
	}
}
type Frame = {
	media_type: string;
	best_effort_timestamp_time: string;
	duration_time: string;
	width?: number;
	height?: number;
	pix_fmt?: string;
	color_transfer?: string;
	nb_samples?: number;
	side_data_list?: { side_data_type: string }[];
};
function sdr(value: { color_transfer?: string; side_data_list?: { side_data_type: string }[] }) {
	return (
		[undefined, "unknown", "bt709", "smpte170m", "iec61966-2-1", "bt470bg", "bt470m"].includes(
			value.color_transfer,
		) &&
		!value.side_data_list?.some((s) =>
			/dovi|dolby|hdr|mastering|content light|dynamic metadata/i.test(s.side_data_type),
		)
	);
}
export async function verifyVideo(path: string, verifier: Verifier, budgetMs = 60_000) {
	const deadline = performance.now() + Math.min(budgetMs, 60_000);
	ensure((await stat(path)).size <= videoByteLimit);
	const { tracks } = await verifyVideoFile(path);
	const input = [
		"-v",
		"warning",
		"-cpucount",
		"1",
		"-threads",
		"1",
		"-protocol_whitelist",
		"file",
		"-f",
		"mov",
		"-enable_drefs",
		"0",
		"-use_absolute_path",
		"0",
		"-codec_whitelist",
		"h264,aac",
		"-err_detect",
		"explode",
	];
	const invoke = (binary: string, args: string[]) => runBounded(deadline, binary, args);
	const probe = async (ignore: boolean) =>
		JSON.parse(
			await invoke(verifier.ffprobe, [
				...input,
				"-ignore_editlist",
				ignore ? "1" : "0",
				"-count_packets",
				"-show_frames",
				"-show_entries",
				"format=duration:stream=codec_type,codec_name,profile,width,height,pix_fmt,color_transfer,sample_rate,channels,nb_read_packets,start_time,duration:stream_side_data=side_data_type:frame=media_type,width,height,pix_fmt,color_transfer,nb_samples,best_effort_timestamp_time,duration_time:frame_side_data=side_data_type",
				"-of",
				"json",
				"-i",
				path,
			]),
		) as {
			format: { duration: string };
			frames: Frame[];
			streams: {
				codec_type: string;
				codec_name: string;
				profile: string;
				width: number;
				height: number;
				pix_fmt: string;
				color_transfer?: string;
				sample_rate: string;
				channels: number;
				nb_read_packets: string;
				start_time: string;
				duration: string;
			}[];
		};
	const presented = await probe(false);
	const duration = Number(presented.format.duration);
	ensure(duration > 0 && duration <= 12 && presented.streams.length === tracks.length);
	const video = presented.streams.find((s) => s.codec_type === "video");
	ensure(video && video.codec_name === "h264" && video.pix_fmt === "yuv420p" && sdr(video));
	const { width, height } = video;
	ensure(width > 0 && height > 0 && width <= 1920 && height <= 1920 && width * height <= 2073600);
	const audio = presented.streams.find((s) => s.codec_type === "audio");
	if (audio)
		ensure(
			audio.codec_name === "aac" &&
				audio.profile === "LC" &&
				[1, 2].includes(audio.channels) &&
				Number(audio.sample_rate) > 0 &&
				Number(audio.sample_rate) <= 48000,
		);
	for (const s of presented.streams)
		ensure(
			Number.isFinite(Number(s.start_time)) &&
				Number(s.duration) > 0 &&
				Number(s.start_time) + Number(s.duration) <= 12.000001,
		);
	ensure(presented.frames.some((f) => f.media_type === "video"));
	for (const frame of presented.frames) {
		const time = Number(frame.best_effort_timestamp_time);
		const span = Number(frame.duration_time);
		ensure(Number.isFinite(time) && time >= 0 && span > 0 && time + span <= 12.000001);
	}
	const stored = await probe(true);
	const audioSamples: number[] = [];
	for (const track of tracks) {
		const stream = stored.streams.find((s) => s.codec_type === track.type);
		const frames = stored.frames.filter((f) => f.media_type === track.type);
		ensure(Number(stream?.nb_read_packets) === track.samples && frames.length === track.samples);
		for (const f of frames) {
			ensure(Number.isFinite(Number(f.best_effort_timestamp_time)));
			if (track.type === "video")
				ensure(f.width === width && f.height === height && f.pix_fmt === "yuv420p" && sdr(f));
			else {
				ensure(f.nb_samples && f.nb_samples <= 1024);
				audioSamples.push(f.nb_samples);
			}
		}
	}
	// Distinct protocol URLs keep the two encoder threads on separate FFmpeg AVIO buffers.
	const decoded = await invoke(verifier.ffmpeg, [
		"-nostdin",
		"-xerror",
		"-filter_threads",
		"1",
		"-filter_complex_threads",
		"1",
		...input,
		"-ignore_editlist",
		"1",
		"-i",
		path,
		"-map",
		"0:v:0",
		"-map",
		"0:a:0?",
		"-fps_mode",
		"passthrough",
		"-threads",
		"1",
		"-stats_enc_pre:v",
		"pipe:1",
		"-stats_enc_pre_fmt:v",
		"v {n}",
		...(audio ? ["-stats_enc_pre:a", "pipe:01", "-stats_enc_pre_fmt:a", "a {n} {samp}"] : []),
		"-f",
		"null",
		"-",
	]);
	let videos = 0;
	let audios = 0;
	for (const line of decoded.trim().split("\n")) {
		if (line.startsWith("v ")) ensure(line === `v ${videos++}`);
		else {
			ensure(line === `a ${audios} ${audioSamples[audios]}`);
			audios++;
		}
	}
	ensure(
		videos === tracks.find((t) => t.type === "video")?.samples && audios === audioSamples.length,
	);
	return { mime: "video/mp4" as const, width, height, duration };
}
