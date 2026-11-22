/**
 * The largest local JPEG or PNG Siluet prepares. The browser refuses a larger file
 * before uploading it, and the server refuses it again with the same words.
 */
export const maxLocalImageBytes = 16 * 1024 * 1024;
export const localImageLimit = "JPEG or PNG up to 16 MiB";
export const localImageLimitRefusal = [
	"The image exceeds the 16 MiB local preparation limit.",
	"Choose a smaller SDR JPEG or PNG.",
] as const;
