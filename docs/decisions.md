# Siluet decisions

## D1 · One creator on one machine

Approved by the owner on 2026-11-21. Siluet serves a single creator over loopback. They supply their own API credentials, choose when to spend on their provider account, and control their locally saved media. Keys stay on the server side of the local application. The selected provider receives the inputs required for the requested operation.

Keeping credentials, charges and files under one person's control avoids shared billing and asset permissions. The tradeoff is that the creator works on the machine running Siluet. Access from another device would require a new product decision.

A successful first session takes a creator from selecting a model and understanding its required inputs to submitting a generation, following the job, saving the result and finding it again when they reopen Siluet. If acknowledgement is lost, Siluet must distinguish an uncertain submission from a confirmed provider failure. The creator decides whether to risk another charge.

### Credit estimates

Calculate estimates locally so creators can review spending offline. Publish public rates through the repository to limit traffic to each provider. Show an unknown total when the price evidence is 30 days old or the rates do not cover the selected options. Once published, Poyo.ai rates also arrive as a v2 feed. Its evidence date is the latest confirmation that the pinned catalog revision is still the newest upstream. The commit date remains the source date. An installation gets later confirmations only through `pricing:refresh`, and should refresh before the expiry that Review shows. A Poyo.ai confirmation later than the local clock is ignored, so the rates age from the source date. Keep any provider-reported charge separate from the estimate. A before-and-after wallet reading shows account-wide movement during a batch. Top-ups, reservations and other clients can change that balance. Show the movement separately from settlement and withhold comparisons for overlapping batches.

An unresolved Poyo.ai submission may still debit the same wallet after a key change. While its outcome is unknown, withhold later wallet comparisons across key revisions. The provider’s media retention period gives no deadline for settlement. Estimates and provider-reported task credits remain available independently.

### Owner sign-in

Claim one owner with a single-use console token, then set a local password and optionally enroll an authenticator. Settings can link OIDC and direct LDAP independently to that owner, with guided OIDC setup for Tinyauth, Authelia and authentik. Authorize method changes by reauthenticating through a currently enabled method, including enrolled MFA. Before activating a new or replacement binding, complete a sign-in through that exact candidate. Before disabling or replacing a method, also require fresh proof through a method that will remain enabled. One sign-in can satisfy both checks when the same method and configuration survive the change. Remove the local password hash and revoke its sessions when the creator disables password sign-in. Bind the single-use, short-lived proof to the initiating browser session, exact change and the configurations being verified. In one transaction consume the proof, apply the change and enforce the last-method check. An explicit offline host recovery restores access to the existing studio. Bind OIDC to issuer and subject and verify signed authentication time for sensitive changes. Bind LDAP to an immutable directory ID over validated TLS. Apply enrolled MFA to all methods. Verify that a Tinyauth username cannot be reassigned before relying on its subject.

Deferred on 2026-11-22: external OIDC and LDAP sign-in move to the backlog. Tinyauth linking remains blocked on subject evidence.

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

## D3 · Local persistence with embedded Turso and Drizzle

Approved by the owner on 2026-11-21. The first approved feature that needs persistence will use embedded Turso through Drizzle ORM. An embedded database keeps setup local to the creator’s machine and requires no separate database service. Drizzle gives the TypeScript application typed queries. Each module’s spec will define the data it needs to retain.

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

## D6 · Verify stored video samples before Gallery publication

Video Save uses locally provisioned FFmpeg and ffprobe 9.0.2. The first qualified build is Linuxbrew 9.0.2_1 on glibc Linux ARM64. Set `SILUET_FFMPEG_DIR` to its trusted absolute bin directory. The server checks both executable fingerprints and decodes the bundled synthetic H.264/AAC specimen under the same limits used by Save. A changed installation must qualify again. Other builds and platforms can Review offline and serve saved clips.

Qualification reads back both inherited address-space limits. Both native tools run under the system setpriv and prlimit with a 512 MiB address-space ceiling, bounded output and a shared 60-second deadline. On this build the glibc allocator needs bounded arenas and explicit worker counts. The Gallery verifier checks MP4 sample tables and presentation timing, probes stored packets and decoded frames with edit lists disabled, then counts each video frame and AAC sample through the null muxer. Siluet retains the verified original MP4.

Gallery compares an opened clip’s size, device, inode and change time with its saved record. When the size matches but the file identity has changed, opening the clip, loading its Gallery entry or starting Siluet verifies the bytes against the saved SHA-256 digest. A match refreshes the cached identity. A content mismatch makes the clip unavailable. A media HEAD request reads metadata only and returns 404 for a changed identity until one of those checks succeeds.
