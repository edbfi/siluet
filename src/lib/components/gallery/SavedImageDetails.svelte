<script lang="ts">
import { meta } from "./gallery-styles";

let {
	mime,
	width,
	height,
	savedAt,
	duration,
}: {
	mime: string;
	width: number;
	height: number;
	savedAt: number;
	duration?: number | null;
} = $props();
const format = new Intl.DateTimeFormat("en", {
	timeZone: "UTC",
	dateStyle: "medium",
	timeStyle: "short",
});
</script>
<p class={meta}>
	{mime === "video/mp4"
		? `MP4 · ${duration?.toFixed(2)} seconds`
		: mime === "image/png"
			? "PNG"
			: "JPEG"}
	· {width} × {height}<br>
	<time datetime={new Date(savedAt).toISOString()}>Saved {format.format(savedAt)} UTC</time>
</p>
