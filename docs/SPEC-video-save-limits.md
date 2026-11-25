# Per-mode video Save limits

**Approved for implementation** by the council on 2026-11-25, with amendments. [Roadmap](SPEC.md) · [D6](decisions.md#d6--verify-downloaded-video-structure-in-typescript) · [First saved video](SPEC-first-saved-video.md)

Gallery saved no video over 12 s, whatever the mode. Each Queue-enabled video operation now has a **Save limit**: the longest output documented for its exact (provider, model, route, operation), quoted beside the value.

| Operation | Limit | Basis | Evidence (accessed 2026-11-24) |
| --- | --- | --- | --- |
| ToAPIs `seedance-2-5` text-to-video, first-frame-to-video, first-and-last-frame-to-video | 30 s | provider | [generation](https://docs.toapis.com/docs/en/api-reference/videos/seedance-2-5/generation): "The official range is `4`–`30`; use `-1` to let the model choose the duration." |
| Poyo.ai `h3-max` text-to-video | 15 s | provider | [H3 Max](https://docs.poyo.ai/api-manual/video-series/h3-max.md): "`duration` is an integer from 5 through 15 seconds; the default is 5." |

**Where it lives.** Every released video operation has `save: { seconds, basis } | null`, with basis `provider` or `upstream`. Seedance registry entries carry it, `poyoVideoEntry` copies it from `PoyoVideoDescriptor.save`, and catalog-engine rows will fill it from data. Review builds the Save disclosure from the operation in one place and binds the number into the terms digest that Queue claims. Queue stores it as `image_job.save_seconds`, and Save reads the job. Claimed jobs keep what they reviewed (as in D10), so a later catalog revision cannot change a queued job's limit.

**Rule.** Save accepts a presented duration > 0 and ≤ the job's limit + 1 s. The 1 s is Gallery's local allowance for container rounding, not a provider guarantee. Observed overruns: H3 Max 5 s presented 5.1667 s; Seedance 4 s presented 4.064 s. The limit belongs to the mode, not the request. A clip longer than requested but within the allowance is the provider's billable output and saves. `-1` (auto) and source-following edits follow the same rule. Sample tables are bounded for limit + 1 s at 60 video frames per second, and at 48 kHz AAC in the 960- or 1,024-sample frames `esds` declares, plus 17 priming frames.

**Source-following operations.** The provider may say the output follows a source without capping the source. Then an uncontradicted upstream vendor cap of 60 s or less may set the limit, with basis `upstream`. Review discloses it as "unverified on this route". Otherwise the mode is Review-only. Siluet never fetches a source URL.

**Review-only.** A mode whose maximum is undocumented, unbounded, conflicting or over 60 s has `save: null`. Review shows only the blocker "Queue is unavailable because Gallery cannot bound this mode's output length." with no "up to N" sentence, and Queue makes zero POSTs.

**Ceiling.** Gallery stores durations up to 61 s (60 s + the allowance). That covers every bounded mode either provider documents except two long-form tools (300 s and 360 s), which stay Review-only. The 64 MiB, 4 MiB `moov`, 1,920 px and 2,073,600 px bounds are unchanged. The real 480p clips run at about 3–4 Mbit/s, so 30 s is about 15 MB.

**Review** shows: "Gallery saves complete H.264/AAC MP4 files up to N seconds, the provider's documented maximum for this mode, plus 1 second for container rounding, within its size and dimension limits. A completed billable clip outside them stays with the provider." For basis `upstream`, the clause reads "the upstream model's documented maximum for this mode, unverified on this route".

**Upgrade.** One append-only migration:

- It adds `image_job.save_seconds`, a positive integer that only video jobs may have.
- It fills every video job from its (provider, model, operation), so jobs queued before this version adopt their mode's limit: Seedance 30, H3 Max 15. Each released key has exactly one route.
- A video job without a recognised key keeps NULL and the former rule: ≤ 12 s, no allowance, 720 video and 580 audio samples.
- It rebuilds `gallery_image` with the 61 s ceiling and copies every row unchanged.

Then each completed, unsaved video held outside the profile is re-armed once if it now has a limit. That costs one status read and no generation, and a clip that still fails is held again. A result the provider reported as not a video stays held, or is held again after one status read once its reads resume. An expired one makes no read. A Review issued before the upgrade goes stale: a fresh click returns `stale` and sends zero POSTs.

**Out of scope:** the offered ranges stay as they are (Seedance 4–10 s, H3 Max 5–10 s); widening them is a separate owner decision. Also out: `-1` requests, 1080p, new operations, byte-cap changes and a Jobs message that names the limit.

**Acceptance:**

- For each shipped mode, a clip at limit + 1 s saves and one tick over is held.
- Sample bounds follow the limit and the declared AAC frame length.
- A mode without a limit is Review-only with zero POSTs.
- Old Gallery rows and jobs upgrade intact.
- Review states each limit.
- The recorded H3 Max and Seedance structures still verify.
