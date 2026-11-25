# Seedance 2.5 source-video edit

**Approved 2026-11-24; Save limit revised 2026-11-25** under the owner's decision and [per-mode Save limits](SPEC-video-save-limits.md). [Roadmap](SPEC.md) · [Decisions](decisions.md) · [First saved video](SPEC-first-saved-video.md) · [Keyframes](SPEC-seedance-keyframes.md)

In Video Studio, Seedance 2.5 · ToAPIs offers **Edit video** beside Create video, Animate a still and First and last frame. The creator pastes one public URL into **Source clip**, describes the change and queues one edit. This release accepts public URLs on ToAPIs only. Siluet does not clean a linked clip.

## Operation

Key `(toapis, seedance-2-5, POST /v1/videos/generations, video-edit)`, profile `seedance-edit`, label **Edit video**, mode `edit`, one role `reference_video`, with a partial profile in the [ledger](media-catalog.v1.json). Earlier jobs keep their labels.

## Request

Queue sends one Bearer-authenticated JSON POST to `https://toapis.com/v1/videos/generations` with `model: "seedance-2-5"`, the trimmed prompt (1–4,000 UTF-8 bytes), `video_operation: "edit"`, `duration: -1` and `aspect_ratio: "adaptive"` (both required for edits), `resolution` 480p or 720p (default 720p), boolean `generate_audio` (default on), `output_format: "mp4"`, `return_last_frame: false`, top-level `disable_nsfw: false`, the reserved `client_business_id` and `video_with_roles: [{url, role: "reference_video"}]`.

An edit draft carries exactly prompt, resolution, generate_audio and one source slot. Studio shows "Edit length and framing follow the source clip." Siluet sends no `image_with_roles`, other media, web search, draft/final or 1080p; other operations' bytes are unchanged. Each Queue makes zero uploads, zero retries and one potentially billable POST.

## Source URL

One public HTTP(S) URL under the [public URL rules](SPEC-seedream-reference-edit.md): at most 2,048 UTF-8 bytes after trimming, including any signed query, with no credentials, local or non-public host, `data:` URL or `asset://` reference. A missing, extra or mis-roled slot, or `reference_video` on another operation, refuses Review and Queue with zero provider calls. Siluet sends the URL exactly as trimmed, with its query and fragment. Review and Queue never fetch, probe or preview it.

The field hint reads: "Public HTTP or HTTPS video URL, up to 2,048 UTF-8 bytes. Siluet does not open, check or clean it before sending it to ToAPIs. A source longer than 30 seconds can be charged for an edit Gallery may not save; Gallery allows the returned clip up to 1 second over its limit for container rounding."

## Review and consent

Review shows **Edit video**, one clip, zero retries, zero uploads and a list labelled "Source clip" with `Source clip · <host>` (no path, query or fragment). The outgoing-request preview shows that label in place of the URL and redacts the prompt. Disclosures:

1. Queue sends your prompt and the complete source-clip URL, including any signed query, to ToAPIs and possibly its upstream processors. They can retrieve and keep the clip with its soundtrack and metadata; their access, fetch timing and copy retention are unknown, fetched copies can outlive a signed link, and ToAPIs keeps API call logs for 90 days by default. The link must work without cookies or extra headers. Use a new URL when the clip changes.
2. Asset review can keep the task queued for up to 20 minutes per round by default. After the ten-minute automatic tracking ends, use Refresh status in Jobs. ToAPIs documents no video generation fee for a failed asset review, and Jobs shows a refund only when billing confirms it.
3. ToAPIs accepts source videos up to 100 MiB. Upstream, BytePlus lists MP4 or MOV (H.264 or HEVC), 4–30 seconds for an edit, 300–6,000 px per edge, a width-to-height ratio of 0.4–2.5, 24–60 fps and 200 MB. It refuses direct videos with real human faces. This route's enforcement is unverified; Siluet does not check them.
4. The edit lasts about as long as the source, which Siluet does not measure. A source longer than 30 seconds can be charged for an edit Gallery may not save; Gallery allows the returned clip up to 1 second over its limit for container rounding. A longer source makes a longer, costlier edit.
5. Actual usage and account charges are unknown. How edit tokens are counted is unknown, and so is whether the source soundtrack stays when audio is off. Eligible accounts or regions may use fallback, with unknown availability and price.
6. The edit's Save limit, generated from the operation: "Gallery saves complete H.264/AAC MP4 files up to 30 seconds, the upstream model's documented maximum for this mode, unverified on this route, plus 1 second for container rounding, within its size and dimension limits. A completed billable clip outside them stays with the provider."

Review chooses disclosures 1–5 by the operation's mode, not its number of media roles.

The quote uses ToAPIs' video-input rate, $6 per million total tokens (observed 2026-11-24); the total depends on token usage. A price never unlocks Queue; the 30-day cutoff applies.

The acceptance reads: "I accept the unknown charge, sending the complete source-clip URL to ToAPIs and its processors under their access and retention terms, and Gallery Save limitations, including that a source longer than 30 seconds can be charged for an edit Gallery may not save; Gallery allows the returned clip up to 1 second over its limit for container rounding."

The video Review signature binds the owner, the exact operation key and the ordered body with `video_with_roles`. The terms digest binds the credential revision, access state, quote and disclosures. A change of model, operation or URL, a new Review or feed expiry clears acceptance. Queue requires a successful video access check for the current key revision. An identical replay returns the same job, also after a restart, and a mismatched replay is refused. Review responses carry no raw URL; diagnostics, job rows and browser storage carry no raw URL or source host; durable data holds no prompt or key.

## Jobs and Save

Submission, authorization, throttling and recovery follow [First saved video](SPEC-first-saved-video.md).

**Save limit.** 30 s, basis `upstream` ([per-mode Save limits](SPEC-video-save-limits.md)). ToAPIs says "Editing accepts only `-1`, and the output length matches the input video" and caps no source; its model guide says "Generate, edit, and extend up to 30-second videos"; upstream, BytePlus says "The input video to be edited must be [4, 30] seconds long." Queue stores 30 with the job. Siluet never fetches or measures the source.

A submit HTTP 400 is confirmed only with a consistent envelope and no task attributes. For `invalid_private_assets`, Jobs shows: "ToAPIs refused the source clip before creating a task. Check that the URL is publicly reachable, points to a readable video within 100 MiB and has no credentials." `invalid_request` and `unsupported_value` are validation and `content_policy_violation` is filtering. A task-type mismatch has no documented code; undocumented codes stay uncertain. The read-only business-ID lookup with the original credential revision attaches a task only when envelope, business ID, model and task ID match; otherwise Jobs shows **May have been submitted**, with zero further POSTs.

A verified failed task with `error.reason: "reference_media_unreadable"` shows "The provider could not read the source clip." Any other edit failure shows the generic message and "Check the source clip against the limits shown at Review." Raw messages and codes are discarded, nothing more is stored and reported billing is kept.

Completion saves automatically (D9) under the full [First saved video Save contract](SPEC-first-saved-video.md#save-and-play-offline):

- Save uses `url`, then at most one optional `fallback_url`, only when an otherwise permitted primary is inaccessible; a destination-policy or verification failure ends the attempt. Confirmed expiry makes zero media reads.
- The file must pass the TypeScript MP4 check (D6); Gallery then reopens it offline.
- A failed download offers Retry download on the same task and never sends another edit.
- A 15-second edit saves. A valid MP4 outside the profile, such as a 31.1-second edit, is held with "Not saved · this video is outside the Gallery profile", no retry, no Gallery entry and reported billing kept.

## Poyo.ai and out of scope

Poyo.ai Seedance 2.5 edit stays unavailable under D4 until slice G. Also out of scope: local clips (R5b), more than one source, extension, references or audio with a source, draft/final, 1080p, MOV output and returned last frames.

## Acceptance

This is an input-class test under D2. Fresh offline fixtures and the [built-app checks](../README.md#development) cover:

- a golden edit body, with the other operations' bytes unchanged;
- zero provider calls for a forged key, duration or aspect ratio on an edit draft, `1080p`, a wrong role or slot count, `reference_video` on another operation, a 2,049-byte URL (2,048 multibyte accepted), credentials, a private host, `data:`, `asset://`, missing access or consent, a changed revision, and feed expiry after Review;
- confirmed `invalid_private_assets` and the other confirmed codes; uncertain cases with a matching and a mismatched lookup; `reference_media_unreadable`; a discarded unknown reason carrying a signed URL;
- a replay across a restart (one job, one POST) and the $6 quote;
- with zero new POSTs: asset review past tracking, then Refresh and Save; a failed download, then Retry download; expiry; a saved 15-second result and a held 31.1-second one;
- a keyboard journey at desktop width and 320 px with a signed URL on a 63-character host: zero source-host reads or DNS resolutions, one POST, no path, query or fragment in the label, no raw URL in Review responses, no raw URL or host in diagnostics, job rows or browser storage, then automatic Save and offline reopen.

Sources, accessed 2026-11-24: [generation and asset review](https://docs.toapis.com/docs/en/api-reference/videos/seedance-2-5/generation) · [errors](https://docs.toapis.com/docs/en/api-reference/errors) · [video status](https://docs.toapis.com/docs/en/api-reference/tasks/video-status) · [pricing](https://toapis.com/model-guide/seedance-2-5#seedance-2-5-pricing-reference) · [retention](https://toapis.com/data-retention) · [model guide](https://toapis.com/model-guide/seedance-2-5) · [BytePlus video input](https://docs.byteplus.com/en/docs/ModelArk/1520757) · [BytePlus Seedance 2.5 video duration](https://ai.byteplus.com/ark/region:ap-southeast-1/docs/seedance-2-5)
