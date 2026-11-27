# Seedance 2.5 keyframe video

**Approved 2026-11-24.** [Roadmap](SPEC.md) · [Decisions](decisions.md) · [First saved video](SPEC-first-saved-video.md)

In Video Studio, Seedance 2.5 · ToAPIs offers two operations beside **Create video**: **Animate a still** starts a clip from one image, and **First and last frame** guides a clip between two images. The creator pastes public URLs into **Starting frame** and **Ending frame**. This release accepts public URLs on ToAPIs only.

## Operations

| Key: `toapis`, `seedance-2-5`, `POST /v1/videos/generations`, … | Frames sent | Label |
| --- | --- | --- |
| `first-frame-to-video` | `image_with_roles: [{url: start, role: "first_frame"}]` | Animate a still |
| `first-and-last-frame-to-video` | the same, then `{url: end, role: "last_frame"}` | First and last frame |

Each key has a partial support profile in the [ledger](media-catalog.v1.json); the registry resolves it in the picker, Review, Queue and Jobs. Text-to-video stays the first Seedance entry, so earlier jobs keep the label **Create video**.

## Request

Queue sends one Bearer-authenticated JSON POST to `https://toapis.com/v1/videos/generations` with `model: "seedance-2-5"`, the trimmed prompt (1–4,000 UTF-8 bytes), `video_operation: "generate"`, integer `duration` 4–10, `resolution` 480p or 720p, boolean `generate_audio`, `aspect_ratio: "adaptive"`, `output_format: "mp4"`, `return_last_frame: false`, top-level `disable_nsfw: false`, the reserved `client_business_id` and `image_with_roles`. Defaults: five seconds, 720p, audio on. A keyframe draft carries no aspect ratio: ToAPIs requires `adaptive` for first/last-frame tasks and takes the framing from the starting frame, so Studio shows "Framing follows the starting frame." Siluet never sends `image_urls`, `reference_image` roles, other media or web search, and offers no ending-frame-only mode. Text-to-video requests stay unchanged byte for byte. Each Queue makes zero uploads, zero retries and one potentially billable POST.

## Frame URLs

Each role takes one public HTTP(S) URL under the [public URL rules](SPEC-seedream-reference-edit.md): at most 2,048 UTF-8 bytes after trimming, including any signed query; no credentials, local or non-public host, data URL or asset ID. The two URLs must differ after trimming (a Siluet restriction; BytePlus allows identical frames). A duplicate, missing, extra or swapped role refuses Review and Queue with zero provider calls. Siluet sends each URL exactly as trimmed, including query and fragment. Neither browser nor server fetches, probes or previews a frame URL, and Siluet does not compare the bytes behind different URLs.

## Review and consent

Review shows the operation label, "one clip, zero retries, zero uploads" beside "1 potentially billable submission", and `Starting frame · <host>` / `Ending frame · <host>`. The outgoing-request preview shows those labels in place of URLs and redacts the prompt. Disclosures:

1. Queue sends your prompt and each complete frame URL, including signed queries, to ToAPIs and possibly its upstream processors. Their access, retention and fetch timing are unknown. Signed links can expire while fetched copies persist. Use a new URL when an image changes.
2. Asset review can keep the task queued for up to 20 minutes per round by default. After the ten-minute automatic tracking ends, use Refresh status in Jobs. ToAPIs documents no video generation fee for a failed asset review; Jobs shows a refund only when billing confirms it.
3. Use still images within ToAPIs' 30 MB limit. Upstream, BytePlus lists JPEG, PNG, WebP, BMP, TIFF, GIF, HEIC and HEIF, 300–6,000 px per edge, a width-to-height ratio of 0.4–2.5, and refuses direct images that contain real human faces. Whether this route enforces those limits is unverified; Siluet does not check them.
4. Actual usage and account charges are unknown. Eligible accounts or regions may use fallback with unknown availability and price.
5. The mode's [Save limit](SPEC-video-save-limits.md): "Gallery saves complete H.264/AAC MP4 files up to 30 seconds, the provider's documented maximum for this mode, plus 1 second for container rounding, within its size and dimension limits. A completed billable clip outside them stays with the provider."

Both operations use ToAPIs' advertised rate for generation without video input ($10 per million total tokens, observed 2026-11-21); Review says the total depends on token usage. A price never unlocks Queue; the 30-day cutoff applies.

The acceptance reads: "I accept the unknown charge, sending the complete frame URLs to ToAPIs and its processors under their access and retention terms, and Gallery Save limitations." The existing video Review signature binds the owner, exact operation key and ordered body including `image_with_roles`; the terms digest binds credential revision, access state, quote and disclosures. Changing model, operation or a frame, or a new Review, clears acceptance. Queue requires the current key revision's successful video access check. An identical replay returns the same job, also after restart; a mismatched replay is refused. Frame URLs, frame hosts, prompts and keys stay out of durable job data, logs and browser storage.

## Jobs and Save

A submit HTTP 400 with a consistent error envelope, `error.code: "invalid_private_assets"` and no task attributes is a confirmed rejection: "ToAPIs refused a frame before creating a task. Check that each URL is publicly reachable, points to a readable still image within 30 MB, and has no credentials." Task attributes or any inconsistency leave the submission uncertain; the read-only lookup by the reserved business ID with the original credential revision attaches a matching task, and a miss or mismatch shows **May have been submitted**, with zero further POSTs.

A verified failed task with `error.reason: "reference_media_unreadable"` shows "The provider could not read a frame image." Every other failure, including an asynchronous `InvalidParameter.TaskTypeConstraint`, shows the generic message; raw messages and codes are discarded and reported billing is kept. ToAPIs documents `reason` as optional; the video status page does not list it.

Result expiry, the use of `url` then one optional `fallback_url`, and Save follow [First saved video](SPEC-first-saved-video.md#save-and-play-offline). Completion saves automatically (D9). The download must pass the TypeScript MP4 check (D6); the Gallery reopens it offline. A failed download offers Retry download on the same task and never generates again.

## Poyo.ai

Poyo.ai Seedance 2.5 keyframes are not offered. Poyo.ai `seedance-2.5` is a Review-only row in the picker's "Poyo.ai video" group, with the reason "Poyo.ai text-to-video is not verified yet (G7)". It can become eligible only through the catalog engine's acknowledged closed-absent path (D4, G7), in a later revision of this spec.

## Out of scope

Local frame files (own spec after ordered-file staging), ending frame only, reference images, audio, video input, extension, draft/final, 1080p, longer durations and returned last frames.

## Acceptance

An input-class test under D2: Seedance 2.5 text-to-video already represents the ToAPIs `/v1/videos/generations` family. Fresh offline fixtures and the [built app checks](../README.md#development) cover:

- golden payloads for both operations, with text-to-video bytes unchanged;
- zero provider calls for a forged key, last-only draft, repeated, missing or swapped role, duplicate URL, 2,049-byte URL, aspect ratio on a keyframe draft, frames on text-to-video, missing access or consent, and a changed revision;
- confirmed and uncertain `invalid_private_assets`, including a contradictory response recovered by business-ID lookup; `reference_media_unreadable`; an unknown reason carrying a signed URL that is discarded; `InvalidParameter.TaskTypeConstraint`;
- identical replay across restart: one job, one POST; token-usage quotes with the advertised rate in both modes;
- asset review past automatic tracking, then Refresh status and automatic Save; a failed download, then Retry download with zero new POSTs;
- a keyboard journey through both modes at desktop width and 320 px with two signed URLs on one host: zero frame-host reads from browser or server, no raw URL in Review responses, and no raw URL or frame host in diagnostics or job rows, one POST with `disable_nsfw: false`, automatic Save and offline reopen.

Sources, accessed 2026-11-24: [generation and asset review](https://docs.toapis.com/docs/en/api-reference/videos/seedance-2-5/generation#asset-review) · [errors](https://docs.toapis.com/docs/en/api-reference/errors) · [video status](https://docs.toapis.com/docs/en/api-reference/tasks/video-status) · [BytePlus video generation API](https://docs.byteplus.com/en/docs/ModelArk/1520757)
