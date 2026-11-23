/**
 * How a staged image relates to its source: cleaned (`none`), cleaned and re-encoded
 * to apply rotation, or the attached bytes sent unchanged because cleaning is off.
 */
export type ImageTransform = "none" | "reencoded-rotation" | "original";
export type StageProfile =
	| { mime: "image/jpeg"; transform: ImageTransform }
	| { mime: "image/png"; transform: "none" | "original" };
export type MediaDescriptor<P extends StageProfile = StageProfile> = P & {
	draft: string;
	handle: string;
	digest: string;
	size: number;
	deadline: number;
};
export type PreparedStageMedia<P extends StageProfile = StageProfile> = P & {
	bytes: Uint8Array<ArrayBuffer>;
	digest: string;
	size: number;
	/** The cleaning setting's revision at admission. Never part of the descriptor. */
	revision: number;
	/** An original declares a rotation. Kept on the server only. */
	rotated: boolean;
};

const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const descriptorKeys = ["deadline", "digest", "draft", "handle", "mime", "size", "transform"];

/** Accept exactly the seven descriptor keys the staging route returns. */
export function parseStageDescriptor(value: unknown): MediaDescriptor | null {
	if (!value || typeof value !== "object" || Array.isArray(value)) return null;
	const record = value as Record<string, unknown>;
	if (Object.keys(record).sort().join() !== descriptorKeys.join()) return null;
	const { mime, transform, draft, handle, digest, size, deadline } = record;
	const profile: StageProfile | null =
		mime === "image/jpeg" &&
		(transform === "none" || transform === "reencoded-rotation" || transform === "original")
			? { mime, transform }
			: mime === "image/png" && (transform === "none" || transform === "original")
				? { mime, transform }
				: null;
	if (
		!profile ||
		typeof draft !== "string" ||
		!uuid.test(draft) ||
		typeof handle !== "string" ||
		!uuid.test(handle) ||
		typeof digest !== "string" ||
		!/^[0-9a-f]{64}$/.test(digest) ||
		!Number.isSafeInteger(size) ||
		(size as number) < 1 ||
		!Number.isSafeInteger(deadline)
	)
		return null;
	return { ...profile, draft, handle, digest, size: size as number, deadline: deadline as number };
}
