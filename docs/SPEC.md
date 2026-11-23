# Siluet ground-floor spec

Siluet's first deliverable is a working local build that a contributor can verify without a provider account. The [decision record](decisions.md) sets the product direction. The production milestones below build on this foundation.

## Acceptance criteria

1. A locked Bun install produces a strict TypeScript, Svelte 5 and SvelteKit 3 application using the Bun adapter. Panda CSS generates the page styles and the page exercises Ark UI for Svelte.
2. Starting the built application listens on loopback. Opening the root page identifies Siluet. A request to `GET /healthz` returns HTTP 200 and JSON `{"status":"ok"}`.
3. Type checking, Biome, focused tests and a production build pass. A Chromium smoke test opens the built server, checks the page and verifies its health response. The [README](../README.md) lists the local commands.
4. The initial PR runs the real `ci-ok` and `pr-policy` checks. CI installs Chromium before running the smoke test. Default-branch protections and dependency auto-merge follow the upstream [edbfi-ci onboarding order](https://github.com/edbfi/edbfi-ci/blob/main/SETUP.md).

The ground floor needs no persistence, credentials, model catalog or paid submissions. Milestone 1 replaces the status fixture with the protected Svelte studio.

## First production milestones

| Order | Capability | What the creator can verify |
| --- | --- | --- |
| 1 | [Owner access](SPEC-owner-access.md) | Claim a fresh installation, enter the protected Svelte studio, sign out and sign back in after restarting. |
| 2 | [Image Studio](SPEC-image-studio.md) | Connect a provider in Settings, select a model by family, choose a connected provider and review the request with its local estimate. |
| 3 | [First saved image](SPEC-first-saved-image.md), [single-reference edit](SPEC-seedream-reference-edit.md) and [multi-reference edit](SPEC-seedream-multi-reference-edit.md) | Queue one text-to-image generation or one edit with 1–10 ordered public image URLs, follow the job, save the result and reopen it in Gallery after restarting. |

## Production capability map

The baseline includes the releases through [#37](https://github.com/edbfi/siluet/pull/37) and the provider evidence observed on 2026-11-22. Siluet serves one creator on loopback, with their own credentials, explicit spending authorization and media saved in the private installation. [D1–D6](decisions.md) and the approved module specs set the scope.

### Shipped on the baseline

- Local password claim, sign-in and durable sessions, with owner data in embedded Turso through Drizzle. Provider Settings verifies and stores Poyo.ai and ToAPIs model keys independently. [Owner access](SPEC-owner-access.md) · [Image Studio](SPEC-image-studio.md)
- Seedream 5.5 reviews offline on both providers and queues text-to-image or ordinary edits with 1–10 ordered public image URLs. Live Queue accepts 1–5 requests with 0–3 extra attempts each. Reordering invalidates unused Review. An identical replay of a claimed Review returns the original job or batch across restart. Siluet sends the ordered URLs to the provider without fetching them. Local files and mixed references are offline-Review only. [First saved image](SPEC-first-saved-image.md) · [Multi-reference edit](SPEC-seedream-multi-reference-edit.md) · [Live batches](SPEC-live-image-batches.md) ([#35](https://github.com/edbfi/siluet/pull/35))
- Jobs tracks durable acknowledgements, distinguishes uncertain submissions from failures, shows reported billing and supports an isolated Poyo.ai wallet comparison. Gallery verifies PNG and JPEG with a full decode, saves on request and reopens or removes images offline. [First saved image](SPEC-first-saved-image.md) · [D5](decisions.md#d5--verify-gallery-images-before-saving)
- The offline registry resolves the reviewed operations for the model picker, Review and Queue. [Media catalog](SPEC-media-catalog.md) ([#32](https://github.com/edbfi/siluet/pull/32))
- Poyo.ai Z-Image queues text-to-image and one public-URL edit with one attempt each, then saves the result. [Z-Image](SPEC-z-image.md) ([#34](https://github.com/edbfi/siluet/pull/34))
- ToAPIs Seedance 2.5 supports one text-to-video generation. Save checks the MP4 structure in TypeScript with no native tools, and saved clips play offline. [First saved video](SPEC-first-saved-video.md) ([#36](https://github.com/edbfi/siluet/pull/36)) · [D6](decisions.md#d6--verify-downloaded-video-structure-in-typescript)
- The owner can require an authenticator at sign-in and recover access on the host with the service stopped. [Owner authenticator](SPEC-owner-authenticator.md) ([#37](https://github.com/edbfi/siluet/pull/37))

### Remaining deliverables and release checks

Milestone numbers above identify the released foundation. The proposed order below applies within each area. Work can proceed in parallel wherever the stated dependencies allow it. Future module specs require council confirmation before implementation. The approved decisions already establish the security and coverage goals.

| Area and order | Capability and dependency | What to verify in production |
| --- | --- | --- |
| Models 1 | **Poyo.ai video family** · Proposed under D2. A generic Poyo.ai video adapter with the D4-compatible H3 Max as the family representative. Record partial coverage. [H3 Max contract](https://docs.poyo.ai/api-manual/video-series/h3-max) | Offline fixtures cover the [contract-family](decisions.md#verification-by-contract-family) cases, and one built-app journey ends in a verified Save and offline playback. Recover the same task or retry Save without another submission. |
| Models 2 | **Catalog engine** · Proposed under D2 and D4. Contract-covered rows for the Poyo.ai image and video families from the pinned catalog and for ToAPIs from curated descriptors. | Validate each row mechanically and fail the drift check on schema changes. Queue only under the amendment's conditions. Review names the verified model and schema date. Exercise the D4 acknowledgement and disclosure paths. |
| Models 3 | **Layer decomposition** · Proposed under D2 after the catalog engine. | Verify that the base image and positioned layers survive Save and offline reopening. Define a Save verification contract for multi-asset images. |
| Models, ongoing | **Additional operations and options** · Extend each released media lifecycle through reviewed adapter slices. | Verify distinct operations, including mixed references and extension, on both providers. Start edits with documented public URLs. Track unsupported output formats and option gaps in the registry. |
| Video | **Seedance operations** · Proposed under D2. URL keyframes, then source-video edit, then WAV reference. Local keyframes wait for Uploads 1, and local source clips and audio for Uploads 2. | Each operation sends its inputs in the reviewed roles and order, then reaches verified Save and offline playback. |
| Uploads 1 | **JPEG and PNG cleanup, then qualified image uploads** · Approved · images in delivery (R1). Qualify each cleaner before enabling its provider routes in ordered edits. [Cleanup spec](SPEC-provider-media-cleanup.md) | Original bytes stay intact. Independent inspection and decode confirm removal of supported metadata and preservation of pixels, displayed orientation and color. Review identifies the verified copies and discloses provider access, retention and deletion terms or unknowns. A recording adapter receives exactly those bytes under generated names only after matching Queue consent. Failed preparation, unsupported formats, stale consent and unsafe destinations transfer zero bytes. Exercise interrupted upload, replay and scratch cleanup. WebP, GIF and other documented inputs require their own qualification before local upload. Record URL-only availability where the provider supports it. |
| Uploads 2 | **Qualified video and audio inputs** · Proposed. MP4 first. MKV waits until a Queue-eligible operation accepts it. Pair each cleaner and upload route with a reviewed Video Studio operation that accepts its output. Reuse the image upload consent and scratch checks. [Cleanup spec](SPEC-provider-media-cleanup.md#supported-media) | For each qualified MP4 or MKV route, compare coded pictures, audio units, timing and playback properties across remux. Give standalone audio files a format-specific preparation and verification contract before enabling local audio references. Verify preservation of the audio content, timing and channel layout, removal of supported metadata and refusal of unqualified files before transfer. |

### D2 coverage acceptance

Start with the PoYo capability catalog at revision `747e5d7` (2026-11-19 UTC) and the ToAPIs public production catalog (2026-11-10 snapshot). Reconcile both with official model and endpoint docs, recording the revision or access date. ToAPIs documents `doubao-seedream-5-5` outside that snapshot. Its model-key inventory varies by account and group, so track account and region eligibility separately. [PoYo catalog](https://github.com/PoyoAPI/poyo-devtools/blob/747e5d75319585d66396a3c05bd1b97d9390ce74/artifacts/capability-catalog.json) · [PoYo docs index](https://docs.poyo.ai/llms.txt) · [ToAPIs catalog](https://docs.toapis.com/docs/en/api-reference/models) · [ToAPIs model-key inventory](https://docs.toapis.com/docs/en/api-reference/chat/list-models) · [Seedream contract](https://docs.toapis.com/docs/en/api-reference/images/seedream-5.5/generation)

The dated ledger in `docs/media-catalog.v1.json` is the canonical inventory for D2. Its reviewed offline operation registry is the source for the model picker, Review and Queue. Both use `(provider, exact model ID, route, operation)` as the key. Keep operation-specific contracts and fixture evidence with the provider adapters and focused tests. The ledger indexes evidence and gaps. Record discovery separately from verified support, credential access and pricing. Reconcile exact IDs and variants with generation, editing, keyframes, extension, layer decomposition and other documented media operations. Track input roles, limits and combinations, D4 compatibility, upload access and retention, request and acknowledgement, status and recovery, output types and expiry, and pricing and billing. Keep partial options and unqualified routes visible.

Include the text, caption and audio inputs of each documented image or video operation. ToAPIs Seedance 2.5 accepts audio-only and mixed-reference generation with `audio_with_roles` entries using `reference_audio`. For local audio, qualify the cleaner, upload route and model operation together. The ToAPIs public upload route lists MP3, WAV and M4A up to 50 MB and returns a reusable public URL. BytePlus lists MP3 and WAV with a 15 MB per-clip limit for its Seedance route. Verify the limits of the intended ToAPIs route before enabling a format. Before transfer, disclose access, retention, deletion and remaining unknowns. Bind verified bytes, order, roles and destination to Review. Fixtures check that the correct returned URL goes to the intended model in the reviewed role and order only after Queue consent. Locally rejected input or stale consent transfers zero bytes. Standalone audio and text model catalogs are outside D2. [Seedance reference limits](https://docs.toapis.com/docs/en/api-reference/videos/seedance-2-5/generation#reference-input-limits) · [Audio upload](https://docs.toapis.com/docs/en/api-reference/uploads/audios) · [Upstream limits](https://docs.byteplus.com/en/docs/ModelArk/seedance-2-5)

Give each row an evidence link and an explicit state:

- **Verified in Siluet**: a model with its own adapter and built-app tests. Each family's representative is one.
- **Contract-covered**: validated mechanically against a verified family under the [amendment](decisions.md#verification-by-contract-family).
- Otherwise **documented and pending**, **provider unsupported**, or **unknown** with the open question.

Track D4 separately as compatible, incompatible or unverified. The [D4 amendment](decisions.md#d4--optional-filtering-on-media-requests) adds two approved exceptions:

- provider-fixed filtering, with a per-Review acknowledgement
- an unconfirmed ToAPIs field, with a Review disclosure

Both ship with the catalog engine. Both count as outstanding coverage until the provider documents the toggle. Show unverified behavior and known conflicts in Review before Queue eligibility is evaluated. Preserve a provider rejection and the original request semantics. [D4](decisions.md#d4--optional-filtering-on-media-requests)

Sample rows for the 2026-11-22 baseline and pending work. Provider docs were checked on that date.

| Provider and model | Operation or named route | State and evidence |
| --- | --- | --- |
| Poyo.ai `seedream-5.5` | Ordinary edit, 1–10 ordered public URLs | Verified in Siluet with fixtures. [Provider contract](https://docs.poyo.ai/api-manual/image-series/seedream-5-5) · [Adapter test](../src/lib/server/providers/poyo/image.test.ts) · [Ordered request test](../src/lib/server/services/queue/request.test.ts) · [Built-app test](../tests/browser/reference-edit.spec.ts) |
| ToAPIs `doubao-seedream-5-5` | Ordinary edit, 1–10 ordered public URLs | Verified in Siluet with fixtures. [Provider contract](https://docs.toapis.com/docs/en/api-reference/images/seedream-5.5/generation) · [Adapter test](../src/lib/server/providers/toapis/image.test.ts) · [Ordered request test](../src/lib/server/services/queue/request.test.ts) · [Built-app test](../tests/browser/reference-edit.spec.ts) |
| Poyo.ai `z-image` | Text-to-image | Verified in Siluet with fixtures. `POST /api/generate/submit` takes `prompt`, `size` and the D4 toggle. [Provider contract](https://docs.poyo.ai/api-manual/image-series/z-image) · [Adapter test](../src/lib/server/providers/poyo/z-image.test.ts) · [Built-app test](../tests/browser/first-saved-image.spec.ts) |
| Poyo.ai `z-image` | One-reference edit | Verified in Siluet with fixtures. The same endpoint requires one URL in `image_urls` and makes `size` optional. The D4 toggle is documented for both operations. [Provider contract](https://docs.poyo.ai/api-manual/image-series/z-image) · [Adapter test](../src/lib/server/providers/poyo/z-image.test.ts) · [Built-app test](../tests/browser/first-saved-image.spec.ts) |
| Poyo.ai `seedream-5.5-layerize` | Layer decomposition | Documented and pending as a separate model ID. [Provider contract](https://docs.poyo.ai/api-manual/image-series/seedream-5-5-layerize) |
| ToAPIs `doubao-seedream-5-5` | Layer decomposition | Documented and pending. One JPEG or PNG reference produces a base image and positioned PNG layers. [Provider contract](https://docs.toapis.com/docs/en/api-reference/images/seedream-5.5/generation) |
| Poyo.ai `seedance-2.5` | Text-to-video | Documented and outstanding under D4. The pinned public catalog sets `additionalProperties: false` and excludes `enable_safety_checker`. The direct REST contract also omits the field. Queue stays unavailable until the acknowledgement path lands with the catalog engine. [Pinned catalog](https://github.com/PoyoAPI/poyo-devtools/blob/747e5d75319585d66396a3c05bd1b97d9390ce74/artifacts/capability-catalog.json) · [REST contract](https://docs.poyo.ai/api-manual/video-series/seedance-2.5) |
| ToAPIs `seedance-2-5` | Video edit via public upload | Documented and pending. MP4 is a cleanup candidate within the upload and edit limits, with H.264 and AAC documented upstream. The upload route excludes MKV. [Edit](https://docs.toapis.com/docs/en/api-reference/videos/seedance-2-5/generation) · [Upload](https://docs.toapis.com/docs/en/api-reference/uploads/videos) · [Upstream model limits](https://docs.byteplus.com/en/docs/ModelArk/seedance-2-5) |
| Poyo.ai `gemini-omni-1.2-flash` | Video edit via file stream upload | Documented and pending with an MP4 edit example. The upload route accepts MKV. The edit operation’s MKV eligibility is unknown. [Edit](https://poyo.ai/hub/gemini-omni-1-2-flash-api-guide) · [Upload](https://docs.poyo.ai/api-manual/file-series/upload-stream) |

Close the audit when every catalog entry and documented operation has an evidence-backed disposition. Close implementation for that dated scope when each in-scope operation and option has a verified or contract-covered production path with no outstanding D4 gap, or the owner approves an explicit scope change. Report pending, blocked and unknown paths alongside the verified scope. Unknown pricing follows D1’s explicit acceptance flow. Use fixture providers and the [development checks](../README.md#development) for release verification. Live billable checks: none by default. A new family whose responses cannot be authored from documentation may use one, with express owner approval. [Amendment](decisions.md#verification-by-contract-family)

### Design and operations

- The [offline workspace](../design/workspace/index.html) provides design references. The approved batch limits and wallet comparison rules above come from the specs and D1.
- Not committed: external OIDC and LDAP sign-in, passkeys, cleaned-copy export, MKV inputs, Gallery import and paging, wallet popovers, cancellation and [ToAPIs account balance](https://docs.toapis.com/docs/en/api-reference/account/get-balance).
- Repository maintenance access, Dependabot security updates and pricing publication are operations work. Verify the outstanding [foundation task](../tasks/todo.md) and actual feed publication independently of the app release. The app must handle absent or stale feeds and use available local rates as documented. [Pricing refresh](../README.md#quick-start)
