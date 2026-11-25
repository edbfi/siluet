# Siluet decisions

## D1 · One creator on one machine

Approved by the owner on 2026-11-21. Siluet serves a single creator over loopback. They supply their own API credentials, choose when to spend on their provider account, and control their locally saved media. Keys stay on the server side of the local application. The selected provider receives the inputs required for the requested operation.

Keeping credentials, charges and files under one person's control avoids shared billing and asset permissions. The tradeoff is that the creator works on the machine running Siluet. Access from another device would require a new product decision.

A successful first session takes a creator from selecting a model and understanding its required inputs to submitting a generation, following the job, saving the result and finding it again when they reopen Siluet. If acknowledgement is lost, Siluet must distinguish an uncertain submission from a confirmed provider failure. The creator decides whether to risk another charge.

### Credit estimates

Calculate estimates locally so creators can review spending offline. Publish public rates through the repository to limit traffic to each provider. Show an unknown total when the price evidence is 30 days old or the rates do not cover the selected options. Once published, Poyo.ai rates also arrive as a v2 feed. Its evidence date is the latest confirmation that the pinned catalog revision is still the newest upstream. The commit date remains the source date. An installation gets later confirmations only through `pricing:refresh`, and should refresh before the expiry that Review shows. A Poyo.ai confirmation later than the local clock is ignored, so the rates age from the source date. Keep any provider-reported charge separate from the estimate. A before-and-after wallet reading shows account-wide movement during a batch. Top-ups, reservations and other clients can change that balance. Show the movement separately from settlement and withhold comparisons for overlapping batches.

An unresolved Poyo.ai submission may still debit the same wallet after a key change. While its outcome is unknown, withhold later wallet comparisons across key revisions, with no time limit (owner reconfirmed 2026-11-24). The provider’s media retention period gives no deadline for settlement. Estimates and provider-reported task credits remain available independently.

ToAPIs rates arrive as a v2 feed that adds the per-reference-image charge. The v1 ToAPIs feed cannot express it, so it stays frozen at its 2026-11-23 observation. Older installations keep quoting edits without the charge until 2026-12-21, or 2026-12-23 after a refresh, and then show unknown totals. A missing or unreadable v2 feed leaves the bundled v2 rates in use and never falls back to v1. Refresh the bundled ToAPIs rates by copying `pricing-data-toapis:pricing/v2/toapis.json`.

### Owner sign-in

Claim one owner with a single-use console token, then set a local password and optionally enroll an authenticator. Settings can link OIDC and direct LDAP independently to that owner, with guided OIDC setup for Tinyauth, Authelia and authentik. Authorize method changes by reauthenticating through a currently enabled method, including enrolled MFA. Before activating a new or replacement binding, complete a sign-in through that exact candidate. Before disabling or replacing a method, also require fresh proof through a method that will remain enabled. One sign-in can satisfy both checks when the same method and configuration survive the change. Remove the local password hash and revoke its sessions when the creator disables password sign-in. Bind the single-use, short-lived proof to the initiating browser session, exact change and the configurations being verified. In one transaction consume the proof, apply the change and enforce the last-method check. An explicit offline host recovery restores access to the existing studio. Bind OIDC to issuer and subject and verify signed authentication time for sensitive changes. Bind LDAP to an immutable directory ID over validated TLS. Apply enrolled MFA to all methods. Verify that a Tinyauth username cannot be reassigned before relying on its subject.

Deferred on 2026-11-22: external OIDC and LDAP sign-in move to the backlog. Tinyauth linking remains blocked on subject evidence.

### No native tools

Siluet ships, provisions and calls no native tool or helper, and adds no package for work the stack already covers (Bun, SvelteKit, TypeScript, sharp, Turso with Drizzle, Panda with Ark UI). ExifTool is a test-only CI oracle. Supported platforms are Linux and macOS (D8).

## D2 · Full image and video model coverage

Approved by the owner on 2026-11-21. Siluet aims to support the image and video models of ToAPIs and Poyo.ai, including the operations and input options each exposes. A creator can use either platform independently. Text prompts, captions and other documented inputs belong to the image or video operation that accepts them. Standalone text models and other non-media model catalogs are outside this scope.

Track coverage by provider, model and operation so that one supported model cannot be mistaken for support for a provider's entire catalog. Official provider sources establish capabilities. Record gaps and unknowns explicitly. This is the coverage target for future modules.

### Verification by contract family

Amended by the owner on 2026-11-22. D2 targets every documented image and video model without testing each one. A contract family shares a provider, route, request envelope, acknowledgement envelope, status and recovery flow, result envelope, and Save contract. Its representative gets offline fixtures for each of these cases:

- acceptance
- confirmed rejection
- uncertain submission
- throttling
- expiry
- failed download
- replay across restart

It also gets one built-app journey that ends in a verified Save and reopens the result offline from the Gallery. Each input class is tested once per family. A capability unique to one model gets its own slice.

Another operation in a verified family becomes **contract-covered** once it passes mechanical validation against the pinned Poyo.ai catalog or a curated ToAPIs descriptor with a drift check. Operations that fail it stay pending or unknown. A contract-covered operation can Queue only when all of these hold:

- D4 allows the operation.
- The price is known, or the creator accepts an unknown one.
- A qualified Save check (D5 or D6) covers the output. Otherwise Siluet fails closed.
- On ToAPIs, the key's inventory lists the model.

Review names the verified model on the same path and the schema date, and states that the model was not tested individually.

Live billable calls are zero by default. A new family whose responses cannot be authored from documentation may use one cheapest call. That call needs express owner approval, and its redacted response becomes a fixture.

### ToAPIs model inventory

Agreed with the council on 2026-11-22; lands with the catalog engine. Siluet keeps one shared inventory snapshot per provider, origin, scope and credential revision, with its check time and exact model IDs, and replaces it atomically. A model is listed, absent from a fresh snapshot or unknown. The inventory varies by account and group, and a listing is not evidence of entitlement, D4 compatibility or pricing.

### Poyo.ai video family

Approved 2026-11-22 under the owner's delegation to council and orchestrator. One adapter serves Poyo.ai `POST /api/generate/submit` video: Bearer JSON `{model, input}`, the shared acknowledgement, the shared status route, one video file and D6 Save. Each model is a typed descriptor of its reviewed inputs, D4 field and v2 rate key, so the catalog engine can add rows as data. H3 Max text-to-video is the verified representative with partial coverage: 5–10 s, 480p or 768p and six fixed ratios. The other inputs stay pending. A Poyo video job has no correlation ID, so job code tells a video job (`video_terms` or a legacy `business_id`) from a ToAPIs correlation, and the ten-minute polling window runs from the durable acknowledgement. A 403 `permission_denied_error` is a permission refusal that keeps the saved key. Any uncertain Poyo job withholds later wallet comparisons. Rates come from the `h3-max` entry of the v2 feed, and without it the total is unknown and needs consent. [Spec](SPEC-poyo-first-video.md)

## D3 · Local persistence with embedded Turso and Drizzle

Approved by the owner on 2026-11-21. The first approved feature that needs persistence will use embedded Turso through Drizzle ORM. An embedded database keeps setup local to the creator’s machine and requires no separate database service. Drizzle gives the TypeScript application typed queries. Each module’s spec will define the data it needs to retain.

### Layer storage

Agreed with the council on 2026-11-22; lands with layer decomposition. Gallery stores the base image and each layer as private files, and the database keeps a manifest of order, placement, identity and each file's digest. The layer spec chooses file naming. Siluet stages the whole item before publishing it and reconciles orphaned files on restart, so Gallery never shows a partial decomposition.

### Delivery and migrations

Agreed with the council on 2026-11-22. Lanes run in parallel, but one integrator merges slices in order and owns the migrations and the recovery fingerprint, so no lane can reorder the chain. A slice's migration is named at merge time so it sorts after every released one. Released migrations are append-only: `scripts/db/released-append-only.ts` compares a candidate with its base in CI and fails when a released migration is changed, removed or backdated, and `scripts/db/released-append-only.test.ts` covers it.

## D4 · Optional filtering on media requests

Siluet uses a fixed default for image and video generation and edits so switching models keeps the single creator’s chosen filtering policy. The composer sends `input.enable_safety_checker: false` to Poyo.ai and `disable_nsfw: false` to ToAPIs. On eligible ToAPIs accounts and regions the latter permits fallback. Show known schema conflicts before queuing. Preserve a rejection because dropping a field and resubmitting could change the result and incur a second charge.

Poyo.ai's state comes from the pinned catalog:

- A declared `enable_safety_checker` is compatible.
- A closed schema without it means filtering is provider-fixed.
- An open schema without it is unverified.

The owner approved two exceptions on 2026-11-22:

- **ToAPIs.** When acceptance of `disable_nsfw: false` is unconfirmed, Siluet may queue after Review discloses that. It still sends the field and never resubmits without it.
- **Documented provider-fixed filtering.** Siluet may queue only after the creator acknowledges in that Review that the provider filters and Siluet cannot send the toggle. That acknowledgement is bound to the Review like spending consent.

Siluet omits a field the schema forbids only on that acknowledged path. It never drops a field the provider accepts.

## D5 · Verify Gallery images before saving

A damaged image can have valid dimensions and headers. Gallery needs a complete pixel decode and access to decoder warnings. Bun 1.4.5 exposes metadata and encoded output. Use sharp with libvips to verify every pixel within the size limits and reject warnings before publishing the original PNG or JPEG bytes.

### Still WebP and per-model output formats

Decided on 2026-11-22 under the owner's delegation; lands at the start of the catalog engine. Fifteen image models in the pinned Poyo.ai catalog offer WebP. Gallery will verify still WebP, lossy and lossless, with the same full decode, warnings and size limits, keep the delivered bytes and serve `image/webp`. Animated WebP and GIF fail closed until a multi-frame Save contract exists; Review either does not offer them or marks the model unsavable. Each model's output format option comes from its own schema: only its values, sent verbatim (`jpg` stays `jpg`), defaulting to the schema default, with the expected type shown in Review. ToAPIs descriptors record their formats the same way. A model without the option may return its default, and Save fails closed with a clear Jobs message for anything outside the supported set.

## D6 · Verify downloaded video structure in TypeScript

Video Save keeps the provider's original bytes. The download must be identity-encoded, match any declared length and stay within 64 MiB. Siluet sniffs the container. For MP4 it walks the top-level boxes from file headers, buffers only `ftyp`, `moov` (at most 4 MiB) and the first 128 bytes of one C2PA box, and checks `mdat` spans against the file size. The top level may also hold one C2PA manifest box after `ftyp` and before `moov` and every `mdat`. It is a `uuid` box with extended type `d8fec3d6-1b0e-483c-9297-5828877ec481`, version 0, flags 0, purpose `manifest` and a zero Merkle offset. Its payload is exactly one JUMBF superbox (`jumb`) led by a `jumd` with the C2PA manifest-store type, the label `c2pa` and toggles 3: requestable and labelled, with no ID, hash or private box. The box is at most 1 MiB and the `jumb` fills it exactly. C2PA allows padding after the store, and version 2.5 still requires the box after `ftyp` but also allows it directly adjacent to `moov`, including immediately after it ([C2PA 2.5 §A.5.2](https://spec.c2pa.org/specifications/specifications/2.5/specs/C2PA_Specification.html#_box_containing_the_manifest)). Siluet refuses the padding, any placement other than after `ftyp` and before `moov` and `mdat`, and a second box. The accepted H3 Max box sits after `ftyp` and immediately before `moov`. Siluet does not validate, strip or display the manifest, so saved and downloaded clips keep the provider's content credentials. The two manifests inspected for this rule (2026-11-24) hold an AI-generation credential, signing details and provider-side identifiers, with no creator personal data. Later provider metadata stays opaque and travels with downloads. Any other `uuid` box fails closed. [C2PA 2.2 §A.5.1.1, §A.5.1.2 and §A.5.3](https://spec.c2pa.org/specifications/specifications/2.2/specs/C2PA_Specification.html#_embedding_manifests_into_bmff_based_assets) · [§11.1.4.2](https://spec.c2pa.org/specifications/specifications/2.2/specs/C2PA_Specification.html#_manifest_store). It requires one self-contained `moov` with one `avc1` video track and at most one `mp4a` track. Every sample lies inside `mdat` with no overlap. For each track the `stts` decode duration equals `mdhd`, with one muxer-compatibility exception. A plain AAC-LC track, whose `esds` has `extensionFlag` 0 and either no backward-compatible sync extension or one declaring SBR absent followed only by zero padding (ISO/IEC 14496-3 §1.6.2.1), with 1,024-sample frames and zero composition offsets may declare `mdhd` as the `stts` total less one access unit. Its single edit must start exactly one access unit (1,024 samples at the `esds` rate) into the media, which is the first sample's whole delta, and end at the decode end within one movie tick. ISO/IEC 14496-12:2015 gives both `mdhd` and the `stts` total as the media length before edits (§8.4.2.3, §8.6.1.2.1), so video keeps strict equality. `ctts` offsets and the edit list (at most one leading empty edit and one rate-1 edit) stay within the track's composition timeline, each in its own timescale, and the edit selects at least one sample. The presented duration is > 0 and at most the job's Save limit plus 1 s, Gallery's local allowance for container rounding. The Save limit is the documented maximum output of the job's exact operation or, for a source-following operation, an uncontradicted upstream cap of 60 s or less, marked unverified on this route. Queue stores it with the job ([per-mode limits](SPEC-video-save-limits.md)). An operation without one of 60 s or less is Review-only. A job queued before any limit existed, with no recognised operation, keeps ≤ 12 s with no allowance, 720 video and 580 audio samples. Otherwise sample tables are bounded at 60 video frames per second and at the declared AAC frame length at 48 kHz for that duration, plus 17 priming frames. `mvhd` equals the longest presented track within rounding. Every SPS in `avcC` (at least one SPS and one PPS) is Baseline, Main or High, 4:2:0 and 8-bit, with a cropped size equal to the sample entry, within 1,920 px per edge and 2,073,600 px. `esds` declares AAC-LC (object type 0x40, audio object type 2) with a sample rate > 0 and ≤ 48 kHz and one or two channels. These checks cover the declared configuration; the browser validates samples when it plays. A truncated download counts as a failed download. Fragmented, encrypted, externally referenced or over-limit files fail closed, as does an HDR transfer declared in `colr` or in an SPS's VUI. WebM and Matroska are recognised by their EBML header and refused with their own message. Gallery explains when the browser cannot play a clip and keeps Download. Video saves run one at a time in the single runtime. Startup removes leftover scratch.

Gallery compares an opened clip’s size, device, inode and change time with its saved record. When the size matches but the file identity has changed, opening the clip, loading its Gallery entry or starting Siluet verifies the bytes against the saved SHA-256 digest. A match refreshes the cached identity. A content mismatch makes the clip unavailable. A media HEAD request reads metadata only and returns 404 for a changed identity until one of those checks succeeds.

## D7 · Prepare local images in process

Sharp (D5) decodes and orients JPEGs in the server: no helper outlives Siluet and no jpegtran ships. As with D5, a decoder crash stops the server and in-flight dispatches resume as uncertain. One slot, the pixel limits and a disabled cache bound memory. A JPEG needs at most the 16 MiB body, its metadata-free copy, the encoder output and the rewrapped copy (each ≤ 30,000,000 bytes), two transient raw decodes (≤ 48 MB each at 16 MP), libvips' own buffer during a 90° or 270° rotation and a packed verification grid of at most 3 MB. A PNG needs at most the body, a copy of its image data, the cleaned copy and one 64 MB transient buffer at a time: the inflated rows, then the raw decode, at 8 MP and 16-bit RGBA. The cleaners read the body through views and hand an exact-sized copy to staging without copying it again. Rotated JPEGs are re-encoded at quality 95 with disclosure, because lossless DCT rotation declines common phone dimensions, rotated phone PNGs exceed Poyo's 10,000,000 bytes, and no provider documents EXIF orientation. A re-encoded copy may exceed its source and stays within 30,000,000 bytes, ToAPIs' file limit. Verification compares the final bytes with the ICC-ignored source on a grid of at most 1 MP: luma PSNR ≥ 40 dB, 99.9th-percentile luma error ≤ 48 and RGB PSNR ≥ 32 dB. Retires W-04 for images.

## D8 · Linux and macOS only

The server runs on Linux and macOS; the owner uses any browser. The launcher, server startup and `owner:recover` refuse any other `process.platform` with "Siluet runs on Linux and macOS only." before native bindings load or the data directory is touched; private-directory preparation also refuses, before any `mkdir`. The guard checks the OS only. Native dependencies (sharp, Turso) decide architecture and libc, and CI tests glibc Linux x64 and ARM64 and Apple Silicon macOS. No Windows code, CI or docs, and no replacement helpers.

## D9 · Save automatically

Every completed result is downloaded into the private Gallery in the data folder. A job's first transition into `completed`, with no hold and no Gallery item, records a durable intent to save. A background worker carries it out from the delivery that the completing status read observed. It adds a status read only for an explicit Retry or to recover work interrupted by a restart or upgrade. It never submits. Signed result links stay in memory and are never persisted or logged. A download that fails or ends incomplete is tried up to three times in all, then Jobs offers Retry download. A completing read without a usable link shows Download failed at once. Shutdown and restart never count as failures. Remove records a `removed` hold; only an explicit Download again clears it. Items removed before this version left no record and may download once more after the upgrade, as may a clip refused before it. Installations that upgrade also download completed, unsaved jobs while their links work. Upgrading to the version that accepts C2PA boxes and AAC priming re-arms each completed, unsaved video held outside the profile once. A result the provider reported as not a video stays held, or is held again after one status read once its reads resume. The re-arm costs one status read and no generation, and a clip that is still refused is held again. Upgrading to per-mode Save limits re-arms each completed, unsaved video held outside the profile once, if its operation now has a limit. A result the provider reported as not a video stays held, or is held again after one status read once its reads resume.

## D10 · Cleaning is a standing opt-out

Siluet cleans every attached file automatically (owner decision 2026-11-22). The owner can turn this off in Settings or during setup. The choice is a revisioned setting that Review binds like spending consent. It is never a fallback. A preparation failure blocks Queue, and a declined file is never sent. An original must still be one complete still SDR JPEG or PNG and pass one bounded decode, so Siluet never submits a file it cannot decode. A change retires staged copies and unconsumed file Reviews. Claimed jobs keep what they reviewed.

`@woss/exiftool` was considered for cleaning on 2026-11-22 and not adopted. It edits tags rather than sanitizing: its JPEG writer copies everything after the first scan verbatim, so hidden trailing bytes, fill runs and unused tables pass through. Siluet's cleaner keeps an allowlist and walks the entropy data. The package was also young and had no MP4 support. ExifTool remains the test-only oracle.

## D11 · v0.1.0 is a scoped preview

Approved by the owner on 2026-11-24. The first release, v0.1.0, is a preview for one local creator containing everything verified on main when it is tagged. GitHub generates the change list from the merged pull requests; there is no CHANGELOG file. Release preparation adds a hand-written coverage table that lists each operation as verified, Review-only or pending and cites each video family's real-clip result, so the preview is not mistaken for full D2 coverage. `package.json` takes the version at tag time. The orchestrator prepares the release and the owner tags it.

Tag only when the commit to tag meets every gate:

- The local checks and hosted `ci-ok` pass.
- On the commit to tag, `scripts/pricing/freshness.ts --fail-within-days 14` passes for the published and bundled Poyo.ai v2 and ToAPIs v2 feeds, so each has more than 14 days left (the weekly backstop's threshold; that job checks only the published feeds), and the feeds price every shipped priced operation.
- The untouched 2026-11-24 real clips, one per shipped video family, pass `verifyVideoFile`, and CI fixtures built from their structure pass while the refusals hold. The built-app video journeys use a synthetic clip, so only real clips prove Save.
- Per-mode video Save limits merge, then the Seedance URL edit ([#62](https://github.com/edbfi/siluet/pull/62)), in the order the owner approved.
- A cross-cutting security review is recorded here as one short entry with its scope, date, findings and their dispositions. Every blocker is resolved or explicitly accepted by the owner.
- The README covers what a creator must know.

v1.0 means D2 is complete for a dated baseline under the [coverage acceptance](SPEC.md#d2-coverage-acceptance), or the owner approves a scope change (owner delegated 2026-11-24; council recommendation). The [plan](../tasks/plan.md) holds the release order.

### Security review 2026-11-25

A three-seat council (Claude Opus, GPT Sol, Gemini 4 Neon) reviewed main at `c3eba10` and #62 against the security-and-hardening checklist. Scope: loopback binding and Host/Origin checks, CSRF, sessions, password, TOTP and host recovery, secrets at rest and file modes, redaction, SSRF and redirects, uploads and scratch quotas, media parsers, Gallery serving, dependency audit, CI permissions and privacy. All three found those sound and raised no blocker except the session cookie below.

Fixed in the security hardening PR:

- Every response from the server hook sends `X-Frame-Options: DENY`, `X-Content-Type-Options: nosniff`, `Referrer-Policy: same-origin` and a CSP with `frame-ancestors 'none'`. Pages use SvelteKit's nonce CSP; `vite.config.ts` justifies each relaxation. `no-referrer` was tried and dropped: browsers then send `Origin: null` on form posts, which the Origin check refuses. SvelteKit's own cross-site form refusal and the Bun adapter's `/_app` assets are served before the hook.
- Saved and staged media send `Cross-Origin-Resource-Policy: same-origin`, `X-Frame-Options: DENY` and a sandboxed, script-free CSP. A video keeps its origin (`sandbox allow-same-origin`) so the browser's own player can fetch its ranges.
- The launcher, server and `owner:recover` set umask 0077, and opening storage tightens `studio.db*` to 0600. Public assets refuse `owner-recovery.sqlite*` and `*.key`.
- Startup and recovery refuse a data directory below a folder that another user owns or can write without the sticky bit, and name that folder with a `chmod g-w,o-w` fix. Group write is allowed for the user's private group (Debian, Fedora): the folder is this non-root user's and in the process group, and `/etc/group` and `/etc/passwd` show the group is theirs alone. Groups only a directory service (sss, LDAP) knows fail closed. Links on the configured path need a root or owner link and a stable folder; the studio then uses only the canonical path. The check reads POSIX mode bits and ownership; ACL grants, as on macOS volumes, are outside it.
- Gallery image verification turns libvips' cache off and decodes every image once under a 5 s timeout. sharp enforces it in `toBuffer` only, so an image outside the Gallery profile decodes to one byte a pixel there instead of through `stats()`.
- MP4 edit durations add as BigInt, and the provider key opens with `O_NONBLOCK`.

Pending owner acceptance: browsers send cookies to every port on a host, so another local web service the owner visits on 127.0.0.1 can receive Siluet's session cookie (Sol: blocker; Opus: accepted risk). A real fix changes how Siluet is reached. Recommendation: accept for v0.1.0, tell creators in the README to use a browser profile without untrusted local web services or to sign out after use, and spec host-isolated access after v0.1.0. The D11 gate stays open until the owner decides.

Follow-up: refusing non-443 ports on result downloads (Gemini) was declined for now. Downloads already pin a vetted public address with TLS and no credentials, and no evidence shows which ports provider CDNs use. Revisit once real result URLs are observed.

## D12 · Never pin or ignore a version to defer an upgrade

Owner correction on 2026-11-22. Leave the Dependabot PR open, failing if necessary, until the ecosystem supports it, as in the owner's other repositories. An open PR keeps the pending upgrade visible, where an ignore rule hides it. The closed TypeScript 7 PR ([#3](https://github.com/edbfi/siluet/pull/3)) stays closed until the owner reopens it (owner, 2026-11-24).
