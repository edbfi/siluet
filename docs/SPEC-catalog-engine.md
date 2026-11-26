# Catalog engine · V1

**Proposed 2026-11-26 for council review.** Implements Models 1 in the [capability map](SPEC.md#remaining-deliverables-and-release-checks) under [D2](decisions.md#verification-by-contract-family), [D4](decisions.md#d4--optional-filtering-on-media-requests), [D5](decisions.md#still-webp-and-per-model-output-formats) and [D6](decisions.md#d6--verify-downloaded-video-structure-in-typescript). It builds on the [media catalog](SPEC-media-catalog.md) and [per-mode Save limits](SPEC-video-save-limits.md). It is the main route to the full D2 coverage that v0.1.0 now waits for (D11, owner revision of 2026-11-26).

## Objective

Today the creator can choose eleven hand-written operations on four models. Each new model costs one adapter. The engine turns verified contract families into data. Each `(provider, exact model ID, route, operation)` row is derived from evidence and checked mechanically. A row that passes becomes **contract-covered**, and Siluet queues it through its family's verified adapter.

What the creator sees:

- The model picker lists every derived row by family. Each row is Queue-eligible or Review-only, with one plain reason.
- Review for a contract-covered row says: "Same request path as verified *H3 Max* on Poyo.ai. Options from Poyo.ai's schema dated 2026-11-19 (`747e5d7`). This model was not tested individually."
- Review also shows the D4 acknowledgement or disclosure where it applies, the expected output type, the Save limit and the estimate or unknown price.
- Results save automatically when Gallery can verify them, including still WebP. Anything else is held with a clear message in Jobs.

Contributors get one ledger that gives every pair a state and its evidence, and a drift check that fails when a provider changes a schema.

## Families and qualified input classes

A family is defined by its provider, route, request and acknowledgement envelope, status and recovery flow, result envelope and Save contract. A row can join a family only when its documented route and status flow are the family's own. Every input it sends must belong to an **input class** that the family's representative has qualified. Each qualification needs fixtures for acceptance, confirmed rejection, uncertain submission, throttling, expiry, failed download and replay across restart, plus one built-app journey to verified Save.

| Family | Representative | Qualified classes today | Added by this spec |
| --- | --- | --- | --- |
| Poyo image, `POST /api/generate/submit`, image files, D5 | `seedream-5.5`, `z-image` | prompt; enum and integer options; `output_format` png/jpeg; 1–10 ordered public URLs in `image_urls`; local JPEG/PNG through the upload stream | still WebP output (G1) |
| Poyo video, same route, one video file, D6 | `h3-max` | prompt; integer and enum options | first frame and first-and-last frames in `image_urls` (G8) |
| ToAPIs image, `POST /v1/images/generations`, D5 | `doubao-seedream-5-5` | prompt; `size`; 1–10 ordered public URLs; local JPEG/PNG upload; `metadata.output_format` | — |
| ToAPIs video, `POST /v1/videos/generations`, D6 | `seedance-2-5` | prompt; duration, resolution and ratio; `first_frame` and `last_frame` URLs; one `reference_video` URL | — |

Each row sends only its qualified classes. It omits unqualified optional inputs and records them as option gaps, so its coverage is partial. If an operation needs an unqualified input, the row stays **documented and pending** and names that class. The engine never treats wire field names as roles. Poyo image `image_urls` is the representative's own convention. Every other role mapping needs a reviewed note that quotes the provider.

Single output only. The engine sends `n: 1` or omits the field when 1 is its default. Multi-output waits for a multi-asset Save contract.

## Deriving rows

**Poyo, from the pinned catalog.** The [capability catalog](https://github.com/PoyoAPI/poyo-devtools/blob/747e5d75319585d66396a3c05bd1b97d9390ce74/artifacts/capability-catalog.json) at `747e5d7` (2026-11-19, sha256 `eebbc67…`, schema `v1-c89a8585107f`) holds 252 entries. 162 of them have image or video results, counting the two music-prerequisite IDs. Commit a compact projection of those entries as `scripts/media-catalog/sources/poyo-<rev>.json`, with `model_id`, `category`, `status`, `input_schema` including descriptions, and `billing`. Keep the source revision, its SHA-256 and the MIT notice beside it. The projection measures about 313 KB, under the 500 KB hook. `bun run catalog:derive` turns the projection and the ledger's documented operations into `src/lib/shared/media-catalog/poyo-rows.json`. CI regenerates the file and fails on any difference. The app never fetches a catalog at runtime.

A row's options come from an accepted schema subset:

- top-level `type: object`, `properties`, `required` and `additionalProperties`
- properties typed `string`, `integer`, `number` or `boolean`, with `enum`, `default`, `minimum`, `maximum`, `minLength` and `maxLength`
- `pattern` only from a reviewed allowlist (`\S`, `^https?://`)
- arrays of `format: uri` strings with `minItems` and `maxItems`

Anything else is outside the subset: `allOf`, `anyOf`, `oneOf`, `not`, `if`, `contains`, nested objects, `x-*` keys and untyped properties. Twelve entries, H3 Max among them, use top-level combinators. If an unsupported construct touches a required input or the whole schema, the row stays pending and names the construct. On an optional property, the engine drops that option as a gap. A reviewed **override** may narrow a row, for example to text mode only, with a quote and the schema hash it was checked against. An override never widens a row, and it becomes stale when the hash changes. The prompt keeps the representative's 4,000-byte envelope or the schema's smaller limit.

**ToAPIs, from curated descriptors.** ToAPIs publishes no schema. One small descriptor per docs page goes in `src/lib/shared/media-catalog/toapis/<page>.ts`. It records:

- exact IDs, route, status route and operations
- each sent field with its wire name, kind, range or enum and default
- the D4 field state, quoted
- output formats, the Save limit with its quote, and the rate key
- the page URL, its access date and the SHA-256 of its Markdown rendering (`<page>.md`, which the docs serve)

Each descriptor cites its page. For example, `gpt-image-2` takes `reference_images` and `resolution` and does not mention `disable_nsfw`, while Seedream 5.5 documents `metadata.output_format` and `disable_nsfw`.

**Drift.** `bun run catalog:drift` is online and runs on a weekly schedule, not in the offline checks. It compares the projection with the upstream catalog head and each descriptor digest with its live page, then fails with an evidence diff. The app keeps its reviewed data until a re-pin lands in a PR that shows the diff. Upstream has already moved: `c89a6a4` (2026-11-23) and `ec73207` (2026-11-26, schema `v1-6f54a97c3c63`). Together they add eleven in-scope models (`bria-rmbg-3.0`, `ideogram-v4.6`, `ideogram-v4.6-edit`, `ltx-2.5-fast`, `ltx-2.5-pro`, five `recraft-v4.1*` variants and `sync-lipsync-3`) and change the `kling-4.0` and `seedance-2.5` schemas and billing. The bundled Poyo v2 price feed already reads `c89a6a4`. G2 re-pins the projection, the ledger and the price feed to one revision. Review names that revision's date.

## When a row can Review and Queue

A derived row is **Review-eligible** when its family is verified and its operation's required inputs are expressible. Review works offline and needs no key.

It is **Queue-eligible** only when every condition below holds. Review names the first one that fails, and Queue then sends zero requests.

1. **Contract-covered.** The family is verified and every sent input is in a qualified class.
2. **D4 allows it**, with the state derived mechanically:
   - Poyo `enable_safety_checker` declared in the catalog or REST page: send `false`.
   - Poyo closed schema without the field: provider-fixed. Queue needs a per-Review acknowledgement: "Poyo.ai applies its own fixed content filtering for this model, and Siluet cannot send its filtering setting." The acknowledgement is bound into the Review digest like spending consent. Only on this path, Siluet omits the field the schema forbids.
   - Poyo open schema without the field: unverified. The row is Review-only, because neither approved exception covers it (see Open questions).
   - ToAPIs `disable_nsfw` documented: send `false`.
   - ToAPIs unconfirmed: send `false`, and Review discloses: "ToAPIs does not confirm that this model accepts Siluet's filtering setting. Siluet sends it anyway and never resends without it."
   - Any conflict between the catalog and the REST evidence blocks Queue, as `queueEvidenceProblem` already does.
   - A provider rejection keeps its original request and is never resubmitted.
3. **Price.** The estimate comes from the v2 feed entry for the row. The collector evaluates only billing shapes it recognises exactly: `fixed`, `tiered` with a known formula string, and `parameterized` with zero reference tokens in text mode. `dynamic`, `token` and unrecognised formulas are unknown, and Queue then needs the D1 unknown-price acceptance. A missing entry gaps only that row, never the whole feed.
4. **Save covers the output.**
   - Images: still PNG, JPEG and WebP only. Each option value must stay within Gallery's 16 MP limit, using the policy below.
   - Video: MP4 only, using the `mp4` value where a format is offered and never `mov`. The Save limit comes from data: the integer maximum of `duration` (the largest of an integer enum), basis `provider`, quoted from the schema. A missing limit, a limit over 60 s or an `x-*` duration keeps the row Review-only. Nominal frames must fit D6's 1,920 px per edge and 2,073,600 px area. V1 offers 360p–768p and leaves 1080p, 2K and 4K pending, as H3 Max does.
5. **Access.**
   - ToAPIs needs the shared inventory snapshot to list the exact ID.
   - Poyo has no entitlement probe. Queue uses a balance-verified key, and Review states that access to this model is unverified, as for H3 Max.

Queue stores the row's evidence revision and its Save limit with the job. Any change to the revision, override, descriptor digest, rate or acknowledgement wording makes an unclaimed Review stale. A fresh click then returns `stale` with zero POSTs. A claimed job keeps what it reviewed, and its historical identifiers stay readable after a row disappears.

## Output formats and still WebP Save

Lands first (G1). Gallery verifies still WebP, lossy and lossless, with the same full sharp decode, warning refusal, 5 s timeout and size limits as PNG and JPEG. It keeps the delivered bytes and serves `image/webp`. A WebP with an `ANIM` chunk or more than one page is held as **unsupported image for Gallery**, and so is GIF. One migration rebuilds `gallery_image` so `mime` also admits `image/webp`, copying every row unchanged.

Each row offers only the formats in its own schema that Gallery can save, sent verbatim (`jpg` stays `jpg`). Review shows the expected type. The default is the schema default when Gallery can save it. Without one, Siluet omits the field and Review shows "provider default, not documented". `gif` is never offered. A model without the option may return any type. Save accepts whatever verifies within the supported set and records the actual type, and holds anything else with a Jobs message. Of the 35 Poyo entries with `output_format`, 15 offer WebP, `gpt-image-2.6-flare` and `-sunburst` also offer GIF, and `seedream-5.0-flash`, `flux-kontext-*` have no default. Seedream's existing format choice moves onto the same path.

## Gallery's 16 MP policy

Gallery keeps its limits of 16,000,000 pixels and 16,384 px per edge. The engine does not offer an option value whose documented or worst-case output exceeds them, and records each one as an option gap.

- Tier values up to 2K are offered. 4K tiers are not: a 4096×4096 output has 16,777,216 pixels.
- An explicit `WxH` is offered only within both limits.
- When the request cannot bound the output, as with `auto` or a reference-following edit, Review states: "Gallery saves images up to 16 megapixels. A completed billable image over that stays with the provider." The statement is bound like the video Save disclosure.
- Save keeps its existing hold for oversized results.

Raising the limit needs a measured decode budget and is out of scope here.

## Shared ToAPIs inventory snapshot

One snapshot is kept per (provider, origin, scope `image` or `video`, credential revision). It holds `checked_at`, the outcome and the exact IDs that `GET /v1/models?type=<scope>` returned, and is replaced atomically in one transaction. ToAPIs documents the list as "models available to the current API key and user group", filtered dynamically.

- A model is **listed**, **absent** from a fresh snapshot, or **unknown**. Unknown covers no snapshot, a failed read, a changed revision or a snapshot older than 24 hours.
- Only *listed* allows Queue.
- Settings and Review offer **Check again**, rate-limited as today to three checks a minute.
- A listing is not evidence of entitlement, D4 compatibility or price.

The migration adds the snapshot tables and leaves `model_access` and the Seedream flag in the credential's authenticated data untouched. Shipped gates keep working until a later check writes both. Old rows cannot be turned into snapshots, because a single-model record would mark every other model absent.

## Failure, unknown and stale cases

- **Schema outside the subset, or an unqualified required input.** The row is pending and Review names the reason. The adapter is never called.
- **Upstream drift.** The CI drift job fails and app behaviour does not change. After a re-pin, removed rows stop queuing and their jobs remain.
- **Price feed and catalog on different revisions.** The rate is unknown, with unknown-price consent.
- **Inventory read fails or goes stale.** The model is unknown and Queue is blocked. The last outcome is kept.
- **ToAPIs rejects `disable_nsfw: false`.** The rejection is confirmed after one POST, with no resubmission. Jobs says the provider refused the request.
- **An output Gallery cannot save** (wrong type, animated, over the limits, over the Save limit). The job is completed and held, with Retry download where D9 allows it.

## Migrations

There are two append-only migrations, named at merge time (D3).

- G1 rebuilds `gallery_image` to add `image/webp`.
- G9 adds the inventory snapshot tables.

Jobs record the evidence revision through the existing terms digest. If the plan needs a column for it, that column is the only other schema change. Each migration comes with an upgrade test from a populated database.

## Project structure

- Derivation, drift and sources: `scripts/media-catalog/{derive,drift,coverage}.ts` and `sources/`.
- Browser-safe rows, descriptors, the schema subset and eligibility: `src/lib/shared/media-catalog/`.
- Wire mapping: the existing family adapters in `src/lib/server/providers/{poyo,toapis}/`. No provider calls another.
- Inventory storage and its service: `src/lib/server/db/` and `src/lib/server/services/providers/`.
- Browser journeys: `tests/browser/catalog-*.spec.ts`.

```ts
// src/lib/shared/media-catalog/toapis/gpt-image-2.ts: one docs page, data only
export const gptImage2 = {
	ids: ["gpt-image-2"],
	route: "POST /v1/images/generations",
	page: { url: ".../images/gpt-image-2/generation", accessed: "2026-11-26", sha256: "…" },
	operations: ["text-to-image", "reference-image-edit"],
	fields: { size: { kind: "enum", values: ["1:1", "16:9" /* … */], default: "1:1" } },
	references: { wire: "reference_images", max: 14 },
	d4: { state: "unconfirmed" },
	formats: null,
	rateKey: "gpt-image-2",
} as const;
```

## Boundaries

- **Always:** keep every row's source, date and quote; fail closed; run the [local checks](../README.md#development).
- **Ask first:** CI workflow changes, which are the scheduled drift job; any change to D4 or the 16 MP limit; any live call.
- **Never:** fetch a catalog or docs page at runtime; drop a field the provider accepts; resubmit after a rejection; widen a row beyond its evidence.

## Acceptance, offline with fixtures

Run `bun run --bun test`, `bun run --bun build` and `bun run --bun smoke`.

1. Derivation regenerates byte-identical rows from the committed projection, and the projection's source SHA-256 matches its recorded revision.
2. Fixture schemas cover each D4 case: declared; closed without the field (provider-fixed); open without it (unverified); and a REST-declared field over an open catalog. They also cover each unsupported construct on a required and on an optional input, and an override checked against a stale hash. Each yields its stated row state and reason.
3. A fixture upstream with one model added, one removed, one enum changed and one billing changed makes `catalog:drift` exit non-zero and list all four. An unchanged upstream exits zero. A descriptor whose page digest changed fails the same way.
4. For each Queue condition, failing that condition alone blocks Queue with its message and zero POSTs.
5. The provider-fixed path:
   - Without the acknowledgement, Queue makes zero POSTs.
   - With it, the body omits `enable_safety_checker`.
   - Changing the wording makes the Review stale.
   - Every other row still sends `false`.
6. The ToAPIs disclosure path sends `disable_nsfw: false`. A rejection fixture yields one POST, a confirmed rejection and no resend.
7. Output formats:
   - Each offered value is sent verbatim, and `gif` is never offered.
   - Lossy and lossless still WebP save, reopen offline and serve `image/webp`.
   - Animated WebP, truncated WebP and GIF are held.
   - An upgrade from a populated database keeps every Gallery row.
8. 16 MP: 4K values are not offered. A 4097×4096 result is held, and a 4000×4000 one saves.
9. Video rows take their Save limit from `duration`. A missing limit, one over 60 s or an `x-*` duration keeps the row Review-only. 1080p is never offered.
10. Inventory: cover listed, absent, failed, stale, revision change and two concurrent checks. Only a fresh *listed* queues, and snapshot replacement is atomic.
11. Review names the verified model, the schema revision and date, and "not individually tested".
12. Each new input class passes the seven family fixtures and one built-app journey to verified Save and offline reopen.
13. `catalog:coverage` gives every expanded pair exactly one state, and the counts match the ledger.

## Slice plan

Slices merge in this order. Each is independently mergeable and reaches its outcome in the built app. G9 can run alongside G3–G8.

| Slice | Creator-visible outcome | Verification |
| --- | --- | --- |
| G1 Still WebP Save | A WebP result saves and reopens offline; animated WebP and GIF are held. | Checks 7 and 8 (hold only); migration upgrade test. |
| G2 Derivation and drift | The picker lists every derived Poyo row as Review-only with its reason; the ledger is re-pinned to one revision with its diff. | Checks 1–3 and 13; weekly drift job (CI change, owner asks first). |
| G3 Per-model formats | Image Review offers each model's own formats and shows the expected type; Seedream moves onto the same path. | Check 7. |
| G4 Poyo images, text-to-image | D4-declared Poyo image rows queue with estimates or unknown-price consent, within 16 MP. | Checks 4, 8 and 11; per-row price-feed gaps. |
| G5 Poyo images, reference edits | The same rows edit with 1–10 ordered URLs and local JPEG or PNG files. | Family fixtures reused; one built journey on a derived row. |
| G6 Provider-fixed acknowledgement | Closed-schema rows queue after acknowledgement: Poyo `seedance-2.5`, gpt-image-2.5/2.6, Ideogram, Kling 4.0 Image, MAI and others. | Check 5. |
| G7 Poyo video, text-to-video | Poyo video rows queue at 360p–768p with data Save limits. | Check 9. |
| G8 Poyo video frames | H3 Max qualifies first and first-and-last frames; derived rows follow with reviewed role notes. | Check 12. |
| G9 ToAPIs inventory snapshot | Settings and Review show listed, absent or unknown per exact model, with Check again. | Check 10; migration upgrade test. |
| G10 ToAPIs image descriptors | ToAPIs image rows queue, with the D4 disclosure where unconfirmed. | Checks 3, 6 and 11. |
| G11 ToAPIs video descriptors | ToAPIs video rows queue text-to-video, frames and one reference video. | Checks 6, 9 and 12. |
| G12 Ledger closure | `catalog:coverage` gives every Poyo and ToAPIs pair its evidence-backed state: verified, contract-covered (with any D4 gap), documented and pending with its class, provider unsupported, or unknown with its question. | Check 13; recount recorded in the ledger. |

**Bespoke work outside the engine, for Phase 3.** Each needs a new class or contract on its family representative first, then joins the engine as data:

- layer decomposition: Poyo `seedream-5.5-layerize` and ToAPIs `layer_decomposition`
- audio inputs: `reference_audio_urls`, `audio_with_roles` and driving-audio avatars such as HeyGen, Kling Avatar and OmniHuman
- video extension: Poyo `flux-3/extend-video` and `veo3.1-extend`, ToAPIs Seedance, Gemini Omni and Grok extend routes
- source-video edits and video-to-video on Poyo: Happy Horse, Wan 2.6/2.7, Kling 4.0, Gemini Omni, motion control, character replacement, upscaling, background removal and translation (translation stays Review-only at 360 s)
- mask, markup and localized-mask edits
- multi-output, sequential image sets and multi-shot
- GIF and SVG outputs
- music-task prerequisites (`generate-music-cover`, `create-music-video`)
- Midjourney actions
- the ToAPIs `/v1/videos` envelope and remix routes
- local MP4, WAV and other formats (Uploads 1 and 2)

## Open questions

For the owner:

1. **Poyo open schemas without the D4 field.** 96 of 162 pinned entries have this shape, and the sampled REST pages (Nano Banana 2, 2 New, 2 Lite, Kling 3.0) also omit the field. Under D4 they stay Review-only, and D2 cannot close. *Recommendation:* extend the ToAPIs disclosure exception to them. Siluet would send `false`, disclose that Poyo does not confirm the field, and never resend. This changes D4.
2. **Re-pin.** *Recommendation:* re-pin to the newest revision when G2 lands and re-date the D2 baseline. The price feed has already left `747e5d7`, and `c89a6a4` is no longer upstream head either, so Poyo confirmations have stopped and the feed now ages from 2026-11-23.
3. **Options over Gallery's limits.** 4K images and 1080p+ video are not offered. Closing those gaps needs either a measured cap raise, plus one cheapest real 1080p clip per video family (live, owner-approved), or an explicit scope exclusion.

For the council:

4. The 24-hour freshness for the inventory snapshot.
5. Whether a balance-verified Poyo key is enough access evidence for every derived row, as it is for H3 Max.
6. The accepted schema subset and the 2K tier bound.

## Unverified

- ToAPIs status routes for image pages that only link the general task doc (for example `gpt-image-2`).
- Whether ToAPIs accepts `disable_nsfw` on pages that omit it, and whether Poyo honours `enable_safety_checker` on open schemas.
- Actual output dimensions per tier and ratio, and the types delivered when a format is requested.
- Per-key Poyo model entitlement.
- Whether ToAPIs' Markdown pages are stable enough to hash without false drift.

## Sources

- PoYo capability catalog at [`747e5d7`](https://github.com/PoyoAPI/poyo-devtools/blob/747e5d75319585d66396a3c05bd1b97d9390ce74/artifacts/capability-catalog.json) (committed 2026-11-19), compared with `c89a6a4` and `ec73207`. Fetched 2026-11-26.
- [PoYo docs index](https://docs.poyo.ai/llms.txt) and sampled REST pages, accessed 2026-11-26.
- [ToAPIs public catalog](https://docs.toapis.com/docs/en/api-reference/models) (2026-11-10 snapshot), [model list](https://docs.toapis.com/docs/en/api-reference/chat/list-models), [Seedream 5.5](https://docs.toapis.com/docs/en/api-reference/images/seedream-5.5/generation), [GPT Image 2](https://docs.toapis.com/docs/en/api-reference/images/gpt-image-2/generation) and [Seedance 2.5](https://docs.toapis.com/docs/en/api-reference/videos/seedance-2-5/generation), all accessed 2026-11-26.
