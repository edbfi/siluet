// https://docs.toapis.com/docs/en/api-reference/videos/seedance-2-5/generation (2026-11-24):
// an edit takes one reference_video, duration -1 and adaptive framing, and lasts as long as the
// source. https://toapis.com/data-retention: API call logs are kept 90 days by default.
export const sourceClipHint =
	"Public HTTP or HTTPS video URL, up to 2,048 UTF-8 bytes. Siluet does not open, check or clean it before sending it to ToAPIs. A source longer than 30 seconds can be charged for an edit Gallery may not save; Gallery allows the returned clip up to 1 second over its limit for container rounding.";

export const editDisclosures = [
	"Queue sends your prompt and the complete source-clip URL, including any signed query, to ToAPIs and possibly its upstream processors. They can retrieve and keep the clip with its soundtrack and metadata; their access, fetch timing and copy retention are unknown, fetched copies can outlive a signed link, and ToAPIs keeps API call logs for 90 days by default. The link must work without cookies or extra headers. Use a new URL when the clip changes.",
	"Asset review can keep the task queued for up to 20 minutes per round by default. After the ten-minute automatic tracking ends, use Refresh status in Jobs. ToAPIs documents no video generation fee for a failed asset review, and Jobs shows a refund only when billing confirms it.",
	"ToAPIs accepts source videos up to 100 MiB. Upstream, BytePlus lists MP4 or MOV (H.264 or HEVC), 4–30 seconds for an edit, 300–6,000 px per edge, a width-to-height ratio of 0.4–2.5, 24–60 fps and 200 MB. It refuses direct videos with real human faces. This route's enforcement is unverified; Siluet does not check them.",
	"The edit lasts about as long as the source, which Siluet does not measure. A source longer than 30 seconds can be charged for an edit Gallery may not save; Gallery allows the returned clip up to 1 second over its limit for container rounding. A longer source makes a longer, costlier edit.",
	"Actual usage and account charges are unknown. How edit tokens are counted is unknown, and so is whether the source soundtrack stays when audio is off. Eligible accounts or regions may use fallback, with unknown availability and price.",
];

export const editAcceptance =
	"I accept the unknown charge, sending the complete source-clip URL to ToAPIs and its processors under their access and retention terms, and Gallery Save limitations, including that a source longer than 30 seconds can be charged for an edit Gallery may not save; Gallery allows the returned clip up to 1 second over its limit for container rounding.";
