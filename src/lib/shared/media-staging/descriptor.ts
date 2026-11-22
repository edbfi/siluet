/** How a prepared image differs from its source beyond metadata removal. */
export type ImageTransform = "none" | "reencoded-rotation";
export type StageProfile =
	| { mime: "image/jpeg"; transform: ImageTransform }
	| { mime: "image/png"; transform: "none" };
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
};
