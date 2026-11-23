// Fresh Poyo H3 Max fixtures, shaped by the public pages:
// https://docs.poyo.ai/api-manual/video-series/h3-max.md
// https://docs.poyo.ai/api-manual/task-management/video-status.md
export const h3Task = "poyo_h3_clip_1";
export const h3ResultUrl = "https://93.184.216.34/result/video?signature=poyo-private";

export const h3Acknowledgement = () =>
	Response.json({
		code: 200,
		data: { task_id: h3Task, status: "not_started", created_time: "2026-11-22T00:00:00" },
	});

export const h3Finished = () =>
	Response.json({
		code: 200,
		data: {
			task_id: h3Task,
			status: "finished",
			credits_amount: 78,
			files: [{ file_type: "video", file_url: h3ResultUrl }],
		},
	});

/** The text-mode per-second rate the collector publishes from the pinned catalog. */
export const h3Rate = {
	kind: "per-second-by-resolution",
	resolutions: { "480p": "10", "768p": "16" },
} as const;
