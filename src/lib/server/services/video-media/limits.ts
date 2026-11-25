import {
	maxSaveSeconds,
	saveAllowanceSeconds,
	saveSecondsProblem,
} from "../../../shared/video-studio/save-profile";

// Gallery's video acceptance limits (D6).
export const videoByteLimit = 64 * 1024 * 1024;
export const movieByteLimit = 4 * 1024 * 1024;
/** The largest C2PA manifest box kept, about 50 times the largest one observed. */
export const contentCredentialsByteLimit = 1024 * 1024;
export const edgeLimit = 1920;
export const areaLimit = 2_073_600;
export { maxSaveSeconds, saveAllowanceSeconds };
/** A video job queued before any Save limit existed keeps ≤ 12 s with no allowance. */
export const legacySaveSeconds = 12;

const framesPerSecond = 60;
const audioRate = 48_000;
const primingFrames = 17;

/**
 * The presented-duration and sample-table bounds for a job's Save limit, or for the legacy
 * rule when it has none (D6). Any other value is a programming error, thrown as a TypeError.
 */
export function saveBounds(seconds: number | null) {
	if (seconds !== null && saveSecondsProblem(seconds))
		throw new TypeError(`Invalid video Save limit: ${String(seconds)}.`);
	if (seconds === null)
		return { presented: legacySaveSeconds, video: 720, audio: (_frameLength: number) => 580 };
	const presented = seconds + saveAllowanceSeconds;
	return {
		presented,
		video: presented * framesPerSecond,
		// Whole access units of the declared frame length at 48 kHz, plus encoder priming.
		audio: (frameLength: number) =>
			Math.ceil((presented * audioRate) / frameLength) + primingFrames,
	};
}
export type SaveBounds = ReturnType<typeof saveBounds>;
