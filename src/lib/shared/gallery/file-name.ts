/** A saved file's download name: the job's short ID, never a provider or user-supplied name. */
export function mediaFileName(jobId: string, mime: string) {
	const name = jobId.slice(0, 8).replace(/[^a-zA-Z0-9-]/g, "");
	if (mime === "video/mp4") return `siluet-video-${name}.mp4`;
	return `siluet-image-${name}.${mime === "image/png" ? "png" : "jpg"}`;
}
