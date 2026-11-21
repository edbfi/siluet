(() => {
	const zImageRatios = ["1:1", "4:3", "3:4", "16:9", "9:16"];
	const h3Ratios = ["16:9", "9:16", "1:1", "4:3", "3:4", "21:9"];
	const imageRatios = [...zImageRatios, "3:2", "2:3"];
	const wideImageRatios = [...imageRatios, "21:9"];
	const seedanceRatios = ["16:9", "9:16", "1:1", "4:3", "3:4", "21:9"];
	const seedanceResolutions = ["480p", "720p", "1080p"];
	const seedanceDuration = { min: 4, max: 30, default: 5 };
	const seedanceAudio = { key: "generate_audio", label: "Generate audio", default: true };
	const seedreamFamily = "ByteDance / Seedream";
	const seedanceFamily = "ByteDance / Seedance";
	const qwenFamily = "Alibaba / Qwen";
	// Z-Image and ToAPIs' Vidu Q3 manual show HTTPS media examples.
	const https = ["https:"];
	const httpOrHttps = ["http:", ...https];
	const stillFormats = ["jpeg", "png", "webp"];
	const uploadImageFormats = [...stillFormats, "gif"];
	// https://docs.poyo.ai/api-manual/file-series/upload-stream
	const poyoImages = { field: "input.image_urls", formats: uploadImageFormats };
	// https://docs.toapis.com/docs/en/api-reference/uploads/images
	const toapisImages = { field: "image_urls", maxBytes: 30_000_000, maxSize: "30 MB" };
	// https://platform.vidu.com/docs/api-reference/video-models/vidu-q3/image-to-video
	// https://platform.vidu.com/docs/api-reference/video-models/vidu-q3/start-end-to-video
	const viduFrames = { ...toapisImages, protocols: https, formats: stillFormats };
	// https://platform.minimax.io/docs/api-reference/video-generation-v2-create
	const h3Frames = { ...poyoImages, protocols: httpOrHttps, formats: stillFormats };
	// https://docs.byteplus.com/en/docs/ModelArk/seedance-2-5
	const seedanceFrames = {
		...poyoImages,
		protocols: https,
		maxBytes: 29_999_999,
		maxSize: "30 MB",
	};
	// ToAPIs channels that review Seedance media reject reference URLs longer than 2048 bytes.
	// https://docs.toapis.com/docs/en/api-reference/videos/seedance-2-5/generation#asset-review
	const toapisSeedanceMaxUrlBytes = 2048;
	// Poyo.ai specifies the image count. File types, URL schemes and size are inferred from Alibaba.
	// https://www.alibabacloud.com/help/en/model-studio/qwen-image-generation-and-editing-api-reference
	const qwenReferences = {
		kind: "image",
		min: 1,
		max: 3,
		protocols: httpOrHttps,
		formats: uploadImageFormats,
		maxBytes: 10_000_000,
		maxSize: "10 MB",
	};
	const imageOutputFormat = {
		key: "output_format",
		label: "Output format",
		values: ["png", "jpeg"],
		default: "png",
	};
	const seedreamAdvanced = [
		{
			key: "background",
			label: "Background",
			values: ["auto", "opaque", "transparent"],
			default: "auto",
		},
		imageOutputFormat,
	];
	const promptExtend = { key: "prompt_extend", label: "Expand prompt", default: true };
	const visibleWatermark = { key: "watermark", label: "Visible watermark", default: false };
	const keyframes = [
		{
			id: "animate",
			label: "Animate a still",
			exact: "Image to video",
			source: { kind: "image", min: 1, max: 1, roles: ["Starting frame"] },
		},
		{
			id: "interpolate",
			label: "First and last frame",
			exact: "First- and last-frame video",
			source: { kind: "image", min: 2, max: 2, roles: ["Starting frame", "Ending frame"] },
		},
	];

	function qwenOperations(ratios, field) {
		return [
			{ id: "generate", label: "Create image", exact: "Text to image", ratios },
			{
				id: "edit",
				label: "Edit image",
				exact: "Reference-guided image edit",
				ratios,
				source: { ...qwenReferences, field },
			},
		];
	}

	const qwenRoutes = [
		["Qwen Image 3.0", "qwen-image-3.0", "qwen-image-3"],
		["Qwen Image 3.0 Pro", "qwen-image-3.0-pro", "qwen-image-3-pro"],
	].flatMap(([name, modelKey, poyoId]) => [
		{
			id: poyoId,
			provider: "poyo",
			name,
			family: qwenFamily,
			modelKey,
			promptMax: 5000,
			evidence: "https://docs.poyo.ai/api-manual/image-series/qwen-image-3",
			resolutions: ["1K", "2K"],
			resolutionDefault: "1K",
			operations: qwenOperations(wideImageRatios, poyoImages.field),
			advanced: [imageOutputFormat, promptExtend],
		},
		{
			id: modelKey,
			provider: "toapis",
			name,
			family: qwenFamily,
			modelKey,
			evidence: "https://docs.toapis.com/docs/en/api-reference/images/qwen-image-3.0/generation",
			filterNote: "ToAPIs’ Qwen manual leaves acceptance and effect undocumented.",
			resolutions: ["1K", "2K"],
			resolutionDefault: "1K",
			operations: qwenOperations(imageRatios, toapisImages.field),
			advanced: [promptExtend, visibleWatermark].map((field) => ({ ...field, metadata: true })),
		},
	]);

	window.SiluetModels = {
		providers: { poyo: "Poyo.ai", toapis: "ToAPIs" },
		image: [
			{
				id: "z-image",
				provider: "poyo",
				name: "Z-Image",
				family: "Alibaba / Z-Image",
				modelKey: "z-image",
				promptMax: 1000,
				evidence: "https://docs.poyo.ai/api-manual/image-series/z-image",
				operations: [
					{ id: "generate", label: "Create image", exact: "Text to image", ratios: zImageRatios },
					{
						id: "edit",
						label: "Edit image",
						exact: "Single-reference image edit",
						ratios: zImageRatios,
						ratioDefault: "auto",
						autoRatio: "Provider decides",
						source: {
							...poyoImages,
							kind: "image",
							min: 1,
							max: 1,
							roles: ["Source image"],
							protocols: https,
							formats: stillFormats,
							maxBytes: 10_000_000,
							maxSize: "10 MB",
						},
					},
				],
				advanced: [],
			},
			{
				id: "doubao-seedream-5-5",
				provider: "toapis",
				name: "Seedream 5.5",
				family: seedreamFamily,
				modelKey: "seedream-5.5",
				evidence: "https://docs.toapis.com/docs/en/api-reference/images/seedream-5.5/generation",
				sizes: ["1K", "1.5K", "2K"],
				sizeDefault: "2K",
				customSize: { minPixels: 921600, maxPixels: 4624220, maxRatio: 16 },
				sizePresets: {
					"1:1": [2048, 2048],
					"4:3": [2304, 1728],
					"3:4": [1728, 2304],
					"16:9": [2560, 1440],
					"9:16": [1440, 2560],
				},
				filterNote: "ToAPIs allows a fallback for eligible accounts and regions.",
				operations: [
					{ id: "generate", label: "Create image", exact: "Text to image" },
					{
						id: "edit",
						label: "Edit image",
						exact: "Reference-guided image edit",
						source: {
							...toapisImages,
							kind: "image",
							min: 1,
							max: 10,
							protocols: httpOrHttps,
							// https://docs.volcengine.com/docs/ark/seedream-5-5?lang=en
							formats: uploadImageFormats,
						},
					},
				],
				advanced: [...seedreamAdvanced, visibleWatermark].map((field) => ({
					...field,
					metadata: true,
				})),
			},
			{
				id: "seedream-5.5",
				provider: "poyo",
				name: "Seedream 5.5",
				family: seedreamFamily,
				modelKey: "seedream-5.5",
				promptMin: 5,
				promptMax: 5000,
				evidence: "https://docs.poyo.ai/api-manual/image-series/seedream-5-5",
				resolutions: ["1K", "1.5K", "2K"],
				resolutionDefault: "2K",
				operations: [
					{
						id: "generate",
						label: "Create image",
						exact: "Text to image",
						ratios: wideImageRatios,
					},
					{
						id: "edit",
						label: "Edit image",
						exact: "Reference-guided image edit",
						ratios: wideImageRatios,
						ratioDefault: "auto",
						autoRatio: "Follow references",
						source: {
							...poyoImages,
							kind: "image",
							min: 1,
							max: 10,
							protocols: httpOrHttps,
							formats: stillFormats,
							maxBytes: 10_000_000,
							maxSize: "10 MB",
						},
					},
				],
				advanced: seedreamAdvanced,
			},
			...qwenRoutes,
		],
		video: [
			{
				id: "viduq3-pro",
				provider: "toapis",
				name: "Vidu Q3 Pro",
				// https://platform.vidu.com/docs/introduction
				family: "Shengshu Technology / Vidu Q",
				modelKey: "vidu-q3-pro",
				promptMax: 5000,
				filterNote: "Vidu Q3’s manual leaves acceptance and effect undocumented.",
				evidence: "https://docs.toapis.com/docs/en/api-reference/videos/viduq3/generation",
				resolutions: ["540p", "720p", "1080p"],
				resolutionDefault: "720p",
				duration: { min: 1, max: 16, default: 5 },
				operations: [
					{
						id: "generate",
						label: "Create video",
						exact: "Text to video",
						ratios: ["16:9", "9:16", "1:1"],
						customRatio: true,
					},
					...keyframes.map((operation) => ({
						...operation,
						framing: "Vidu usually follows the reference image.",
						source: { ...operation.source, ...viduFrames },
					})),
				],
				advanced: [
					{ key: "audio", label: "Generate audio", default: true },
					{
						key: "audio_type",
						label: "Audio type",
						values: ["all", "speech_only", "sound-effect_only"],
						labels: ["Speech and sound effects", "Speech only", "Sound effects only"],
						default: "all",
						requires: "audio",
						metadata: true,
					},
					{ key: "seed", label: "Seed", input: "number" },
				],
			},
			{
				id: "h3-max",
				provider: "poyo",
				name: "H3 Max",
				family: "MiniMax / Hailuo",
				modelKey: "h3-max",
				promptMax: 50000,
				evidence: "https://docs.poyo.ai/api-manual/video-series/h3-max",
				resolutions: ["480p", "768p", "1080p"],
				resolutionDefault: "768p",
				duration: { min: 5, max: 15, default: 5 },
				operations: [
					{ id: "generate", label: "Create video", exact: "Text to video", ratios: h3Ratios },
					...keyframes.map((operation) => ({
						...operation,
						framing: "H3 Max follows the starting frame.",
						source: { ...operation.source, ...h3Frames },
					})),
				],
				advanced: [],
			},
			{
				id: "seedance-2-5",
				provider: "toapis",
				name: "Seedance 2.5",
				family: seedanceFamily,
				modelKey: "seedance-2.5",
				filterNote: "Some ToAPIs channels review reference media before generation.",
				evidence: "https://docs.toapis.com/docs/en/api-reference/videos/seedance-2-5/generation",
				resolutions: seedanceResolutions,
				resolutionDefault: "720p",
				// Reference modes and extension are outside this prototype.
				operations: [
					{
						id: "generate",
						label: "Create video",
						exact: "Text to video",
						ratios: seedanceRatios,
						duration: seedanceDuration,
					},
					...keyframes.map((operation) => ({
						...operation,
						duration: seedanceDuration,
						framing: "Seedance follows the starting frame.",
						source: {
							...operation.source,
							...toapisImages,
							field: "image_with_roles",
							wireRoles: ["first_frame", "last_frame"],
							maxUrlBytes: toapisSeedanceMaxUrlBytes,
							// ToAPIs defers to the model's format limits. Still formats are inferred from Seedance.
							// https://docs.byteplus.com/en/docs/ModelArk/seedance-2-5
							protocols: httpOrHttps,
							formats: stillFormats,
						},
						fixed: { aspect_ratio: "adaptive" },
					})),
					{
						id: "edit",
						label: "Edit video",
						exact: "Source video edit",
						framing: "Adaptive framing and the source clip’s duration.",
						source: {
							kind: "video",
							min: 1,
							max: 1,
							roles: ["Source video"],
							field: "video_with_roles",
							wireRole: "reference_video",
							maxUrlBytes: toapisSeedanceMaxUrlBytes,
							protocols: httpOrHttps,
							// https://docs.volcengine.com/docs/ark/seedance-2-5?lang=en
							formats: ["mp4", "mov"],
							// https://docs.toapis.com/docs/en/api-reference/uploads/videos
							maxBytes: 50_000_000,
							maxSize: "50 MB",
						},
						fixed: { video_operation: "edit", aspect_ratio: "adaptive", duration: -1 },
					},
				],
				advanced: [
					seedanceAudio,
					{ key: "output_format", label: "Output format", values: ["mp4", "mov"], default: "mp4" },
				],
			},
			{
				id: "seedance-2.5",
				provider: "poyo",
				name: "Seedance 2.5",
				family: seedanceFamily,
				modelKey: "seedance-2.5",
				evidence: "https://docs.poyo.ai/api-manual/video-series/seedance-2.5",
				schemaWarning:
					"Poyo.ai’s published Seedance schema excludes enable_safety_checker. The provider may reject this request.",
				resolutions: seedanceResolutions,
				resolutionDefault: "720p",
				duration: seedanceDuration,
				operations: [
					{ id: "generate", label: "Create video", exact: "Text to video", ratios: seedanceRatios },
					...keyframes.map((operation) => ({
						...operation,
						framing: "Seedance follows the starting frame.",
						source: { ...operation.source, ...seedanceFrames },
						fixed: { aspect_ratio: "auto" },
					})),
				],
				advanced: [seedanceAudio],
			},
		],
	};
})();
