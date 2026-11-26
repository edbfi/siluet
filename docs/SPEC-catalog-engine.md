# Catalog engine · V1

**Revision 2, 2026-11-26, for council review.** Applies the round-1 rulings and the owner's D4 and size rulings of 2026-11-26. Implements Models 1 in the [capability map](SPEC.md#remaining-deliverables-and-release-checks) under [D2](decisions.md#verification-by-contract-family), [D4](decisions.md#d4--optional-filtering-on-media-requests), [D5](decisions.md#still-webp-and-per-model-output-formats) and [D6](decisions.md#d6--verify-downloaded-video-structure-in-typescript), on top of the [media catalog](SPEC-media-catalog.md) and [per-mode Save limits](SPEC-video-save-limits.md). v0.1.0 waits for full D2 coverage ([D11](decisions.md#d11--v010-waits-for-full-d2-coverage); the anchor exists once PR #72 merges). Every slice here lands before the tag. The [remaining-work inventory](catalog-engine-inventory.md) assigns each pair to a slice or a question.

## Objective

Today the creator can choose eleven hand-written operations on five models. The engine turns verified contract families into data. Each `(provider, exact model ID, route, operation)` row is derived from evidence and checked mechanically. A row that passes becomes **contract-covered**, and Siluet queues it through its family's verified adapter.

What the creator sees:

- The picker lists every derived row by family as Queue-eligible or Review-only, with one plain reason.
- Review for a contract-covered row says: "Same request path as verified *H3 Max* on Poyo.ai. Options from Poyo.ai's schema dated 2026-11-26 (`ec73207`). This model was not tested individually."
- Review also shows the D4 acknowledgement or disclosure, the expected output type, the Save limit, the access note and the estimate or unknown price.
- Results save automatically when Gallery can verify them, including still WebP. Anything else is held with a clear message in Jobs.

Contributors get one ledger with a state and evidence for every pair, a coverage report that counts what blocks the tag, and a drift check.

## Families and admission

A family is its provider, route, request and acknowledgement envelope, status route and recovery, result envelope and Save contract. A row joins a family only with evidence for its exact ID covering all six:

- **Request:** the pinned schema (Poyo.ai) or the model's page (ToAPIs).
- **Acknowledgement:** the documented submit response.
- **Recovery:** how a lost acknowledgement is matched again. ToAPIs needs `client_business_id` on the row's route. A Poyo.ai job has no correlation, so job code identifies it, as for H3 Max.
- **Status route:** Poyo.ai's shared `GET /api/generate/status/{task_id}`. ToAPIs images use the generic `GET /v1/images/generations/{task_id}` ([image status](https://docs.toapis.com/docs/en/api-reference/tasks/image-status), which documents `client_business_id`) only where the model's page links it. The `gpt-image-2` page does not, so that row is Review-only.
- **Result:** the documented completed envelope with a media URL.
- **Save:** an output that D5 or D6 verifies.

`service_type` and `execution_mode` are part of the evidence. All 162 in-scope entries read `generate` and `async`, and a row that differs is pending.

| Family | Representative | Qualified classes today | Added here |
| --- | --- | --- | --- |
| Poyo.ai image, `POST /api/generate/submit`, D5 | `seedream-5.5`, `z-image` | prompt; enum and integer options; `output_format` png/jpeg; 1–10 ordered public URLs in `image_urls`; local JPEG/PNG | boolean, number and free-text options (G4); still WebP (G1) |
| Poyo.ai video, same route, D6 | `h3-max` | prompt; enum and integer options | booleans (G7); frames in `image_urls` (G8); `reference_image_urls` (G8b) |
| ToAPIs image, `POST /v1/images/generations`, D5 | `doubao-seedream-5-5` | prompt; `size`; 1–10 ordered public URLs; local JPEG/PNG; `metadata.output_format` | more than 10 references (G10b) |
| ToAPIs video, `POST /v1/videos/generations`, D6 | `seedance-2-5` | prompt; duration, resolution, ratio; `first_frame` and `last_frame`; one `reference_video` | other exact IDs (G11a) |

Each new class needs the seven D2 fixtures on its representative and one built-app journey from Queue to verified Save and offline reopen. The ToAPIs video adapter now accepts only `seedance-2-5` in its task envelope (`toapis/video.ts`). G11a generalizes it to the row's submitted ID. A page whose response names another model, such as MiniMax-H3's, needs a reviewed rule.

Verified representatives keep their reviewed descriptors. The deriver cross-checks them and fails on any disagreement, but never rewrites them. The engine reads no wire name as a role. Only reviewed **family conventions** do, each with its quote:

- `image_urls` as ordered image references on Poyo.ai images (Seedream 5.5: "Optional 1–10 reference image URLs").
- `n` as output count where the schema says "Number of output images" or "Number of images to generate".
- `duration` as output seconds where the schema or page says so (H3 Max: "`duration` is an integer from 5 through 15 seconds").

Any other mapping needs a reviewed note that quotes the provider. A row sends only qualified classes, and it omits other optional inputs as option gaps. A row whose operation needs an unqualified input stays pending and names the class. One output per request: Siluet sends `n: 1` unless the schema default is 1. Derived rows start at one request and zero retries.

## Deriving and validating rows

**Poyo.ai.** The capability catalog ([`747e5d7`](https://github.com/PoyoAPI/poyo-devtools/blob/747e5d75319585d66396a3c05bd1b97d9390ce74/artifacts/capability-catalog.json), 2026-11-19, sha256 `eebbc67…`) holds 252 entries. 162 are in scope: those whose category gives an image or video result, plus the two music-prerequisite IDs. G2c re-pins to the newest head (now [`ec73207`](https://github.com/PoyoAPI/poyo-devtools/blob/ec7320720913a55f955e1bf6a651e9c38bd356c5/artifacts/capability-catalog.json), 2026-11-26, sha256 `844ed1d…`, 173 in scope). It does so in a data-only PR that shows the diff, re-dates the D2 baseline and moves the v2 price feed to the same revision.

`scripts/media-catalog/sources/poyo-<rev>.json` holds a deterministic projection of the in-scope entries: `model_id`, `category`, `status`, `service_type`, `execution_mode`, `input_schema` with descriptions, and `billing`. The upstream revision, upstream SHA-256, projection SHA-256 and MIT notice sit beside it. It measures about 313 KB, under the 500 KB hook. `bun run catalog:derive` turns it, the ledger and reviewed overrides into `src/lib/shared/media-catalog/poyo-rows.json`. The app never fetches a catalog at runtime.

**ToAPIs.** ToAPIs publishes no schema. Each docs page gets one descriptor, `src/lib/shared/media-catalog/toapis/<page>.ts`, with:

- exact IDs, route, status route, correlation field and operations
- each sent field: wire name, kind, range or enum, default and quote
- the D4 state, output formats, the Save bound with its quote and the rate key
- the page URL, access date and SHA-256 of its Markdown rendering

**Validation.** Queue validates the complete body it will send, with defaults applied as the provider sees them, including `n`, the D4 field and media URLs. `src/lib/shared/media-catalog/schema.ts` is an in-repo validator for the constructs the catalog uses:

- `type`, `properties`, `required`, `additionalProperties`, `enum`, `default`, `minimum`, `maximum`, `minLength` and `maxLength`
- arrays with `items`, `minItems` and `maxItems`, and `format: uri`
- `allOf`, `not`, `if`/`then`/`else`, and `anyOf` whose branches are `required` lists or `properties` with `required`
- `pattern`, from an allowlist only. That holds `\S`, `^https?://` and `^https?://\S+$`, plus each reviewed `size` pattern. The validator runs the pattern on the value.

`oneOf`, `contains`, `const`, `x-*` keys, nested objects and untyped properties are outside it. Fourteen entries use `oneOf` and five use `x-server-validation` (see the [inventory](catalog-engine-inventory.md#option-classes-in-the-pinned-schemas)). Such a construct keeps the row pending if it touches a required input or the whole schema. Otherwise it drops that option as a gap.

A **reviewed rule** expresses one cross-field constraint, quotes it and records the SHA-256 of the schema it was checked against. Examples are a `oneOf` between modes or a `size` pattern's grammar. A reviewed **override** may only narrow a row. Either goes stale when the hash changes, and every construct and rule has a negative fixture. A patterned `size` is offered as its listed ratios and as `WxH` within Gallery's limits, sent as `{w}x{h}` and checked against the pattern. If no valid minimal request exists (prompt, required inputs, defaults), the row stays pending.

**Prompt limits.** Prompts follow the family envelope and the schema's `maxLength`, and both are enforced. `maxLength` counts Unicode code points, as JSON Schema does. The envelopes are:

- Poyo.ai image: code points, as shipped (Seedream 5–5,000, Z-Image 1,000).
- Poyo.ai and ToAPIs video: 4,000 UTF-8 bytes (`video-studio/request.ts`) and the schema's code-point limit.
- ToAPIs image: the Seedream envelope or the page's stated limit.

**Drift.** At a re-pin, `catalog:drift --repin` checks that the fetched upstream file matches its recorded SHA-256 and that projecting it reproduces the committed projection byte for byte. The offline checks verify the projection's recorded SHA-256 and regenerate the rows, failing on any difference. Run weekly and online, `catalog:drift` compares the projection with the upstream head. It also compares the digest of every source that controls eligibility: the [docs index](https://docs.poyo.ai/llms.txt), each REST page behind an override, each ToAPIs descriptor page and the ToAPIs model list. It fails with an evidence diff, and app behaviour changes only through a reviewed re-pin.

## When a row can Review and Queue

The Review screen, with options, disclosures and an estimate from bundled feeds, works offline and needs no key. The signed Review that Queue claims needs a saved credential: `submission.ts` returns `stale` without one. That stays as shipped.

A row is **Queue-eligible** only when every condition holds. Review names the first that fails, and Queue then sends zero requests and transfers no staged media.

1. **Contract-covered.** The family admits the row, every sent input is a qualified class and the body validates.
2. **D4 allows it** (table below).
3. **Price.** A quote needs a known rate or the creator's D1 unknown-price acceptance.
4. **Save covers the output** (D5, D6, below).
5. **Access.**
   - ToAPIs: the inventory snapshot lists the exact ID, re-read on the server at claim.
   - Poyo.ai: a balance-verified key, with the Review note "Poyo.ai does not publish per-key model access. Siluet has checked only that this key works."

### D4 by catalog and REST evidence

Siluet sends the filtering field on every model, documented or not, unless the schema forbids it (D4, revised 2026-11-26).

| Pinned catalog | REST page declares the field | REST says filtering is fixed | REST is silent |
| --- | --- | --- | --- |
| declares `enable_safety_checker` | send `false` | contradiction: blocked | send `false` |
| closed schema without it | contradiction: blocked | acknowledged, omit | acknowledged, omit |
| open schema without it | send `false` (override) | send `false`, disclosed | send `false`, disclosed |

A page that explicitly refuses the field or `false` blocks the row in every case except a closed schema, which already omits the field. A blocked row is Review-only and counts as tag-blocking until the owner decides. REST-sourced states are reviewed overrides with a quote and the page's SHA-256, which drift watches. ToAPIs descriptors record `documented` (send `false`), `unconfirmed` (send `false`, disclosed) or `refused` (blocked).

Exact wording, each part of the Review digest:

- **Acknowledgement**, on closed schemas: "Poyo.ai's schema for this model has no filtering setting and allows no fields it does not list, so Siluet sends this request without one. Filtering is up to Poyo.ai. I understand."
- **Poyo.ai disclosure**, on open schemas: "Poyo.ai does not document a filtering setting for this model. Siluet sends `enable_safety_checker: false` anyway. It may have no effect, and Siluet never resends without it."
- **ToAPIs disclosure:** the same, with "ToAPIs" and `disable_nsfw: false`.

A provider rejection keeps its original request and is never resubmitted. `queueEvidenceProblem` changes from "`d4` must be declared" to the table's outcome. It blocks only contradictions and refusals, and an acknowledged row without its acknowledgement. The shipped `catalogD4` conflict check stays.

### Pricing

A price applies only on an exact match of operation, resolved options, billing unit and reference counts, within D1 freshness. Anything else is unknown. The collector evaluates `fixed`, `tiered` with a known formula string, and `parameterized` without reference tokens. `dynamic`, `token` and other formulas are unknown. A missing entry gaps only that row.

A rate is valid for a row while the SHA-256 of that entry's canonical `billing` and `input_schema` matches the projection's, so a re-pin that leaves the entry unchanged keeps its rate. The v2 feed cannot carry the digest: older builds decode only credit decimals inside rates and exact top-level keys. The collector therefore publishes `pricing/v2/poyo-basis.json` beside it with `{revision, digests}`. Older builds ignore that file. Newer builds treat a missing or mismatched digest as unknown.

New Poyo.ai rate kinds stay within the shipped grammar: a `kind` matching `^[a-z][a-z0-9-]{0,63}$`, nested records of credit decimals at most four levels deep with keys matching the rate-key pattern, at most 1,000 rates and a 64 KiB wire limit. Older builds then keep them as unquotable. About 173 rates must average under roughly 370 bytes.

ToAPIs derived rows use unknown-price consent. The v2 ToAPIs decoder requires exactly its six rates and two gaps, so adding a model would make older builds discard every refreshed ToAPIs rate. The fixture suite covers a quote that expires between Review and Queue: the claim returns `stale` with zero POSTs.

### Claims and replay

At claim, the job stores the exact operation key and a recoverable contract in a new `image_job.contract` column. That contract holds the projection revision, the row digest, the family adapter version, the status route, the result envelope, the Save limit and the formats. A claimed job dispatches, recovers and saves from what it stored, even after a re-pin removes its row.

The Review digest binds:

- the exact body
- disclosures and acknowledgements
- the price quote
- the access evidence: snapshot check time and credential revision
- the staged media digests

A change to any of them, to an override or rule hash, or to the D4, Save or Gallery-size wording makes an unclaimed Review stale. A fresh click then returns `stale` with zero POSTs and zero uploads.

### Access refusals

A Poyo.ai image 403 `permission_denied_error` is a per-job permission refusal that keeps the saved key, as video already does. Today `poyo/image.ts` maps it to an authorization failure. Siluet records a confirmed refusal per (credential revision, model), and Review shows it with its date. Queue stays available, and a new credential revision clears the record.

## Save

### Images and still WebP (G1)

Gallery verifies still WebP, lossy and lossless, with the same full sharp decode, warning refusal, timeout and size limits as PNG and JPEG. It keeps the delivered bytes and serves `image/webp`. Before decoding, a RIFF walk checks the file:

- The size field equals the file length less 8, with no trailing bytes.
- Every chunk fits, and odd sizes carry one zero pad byte.
- The chunk set is the still one: `VP8 ` or `VP8L`, or `VP8X` with `ICCP`, `EXIF`, `XMP `, `ALPH` and one image chunk.

The walk refuses the `VP8X` animation flag, `ANIM` and `ANMF`, and sharp's `pages > 1`. A refusal is held as **unsupported image for Gallery**, as GIF is. A truncated WebP takes the failed-download path (D9). Downloads are named `.webp`. The migration rebuilds `gallery_image` to admit `image/webp` and copies every row and every video constraint unchanged, including the 61 s ceiling.

### Output formats (G3)

Each row offers only its schema's formats that Gallery can save, sent verbatim (`jpg` stays `jpg`). Review shows the expected type. The default is the schema default when Gallery saves it. Otherwise Siluet omits the field and Review shows "provider default, not documented". `gif` is never offered. A model without the option may return any type. Save records the actual verified type and holds the rest.

At `747e5d7`, 35 in-scope entries have `output_format`. D5 says fifteen offer WebP, but a recount on the same basis finds sixteen: `flux-3-klein` and `-edit`, `gpt-image-2.5-flare` and `-sunburst`, `gpt-image-2.6-flare` and `-sunburst`, `kling-o1-image-edit`, `kling-o3-image` and `-edit`, `mai-image-2.7` and `-flash`, `nano-banana-2-official` and `-edit`, `nano-banana-2-new` and `-edit`, and `qwen-image-2.1`. `gpt-image-2.6-flare` and `-sunburst` also offer GIF. `seedream-5.0-flash` and `flux-kontext-*` have no default.

### Gallery size limits

The owner asked on 2026-11-26 for Gallery to support every size the providers offer. Today Gallery saves up to 16,000,000 pixels and 16,384 px per edge. D6 allows 1,920 px per edge, 2,073,600 px, 64 MiB and 60 fps.

- Until G13 and G14 land, an option value over these limits is an option gap. Each gap blocks the tag.
- G13 raises the image limits to the largest documented output, for example 4K tiers (4096×4096) and explicit `WxH`. It uses a decode budget measured in CI for peak memory and time.
- G14 raises the video limits to the documented maximums with measured budgets for bytes, `moov` size and frame rate. That includes 1080p, 2K and 4K. A structure outside D6's profile, such as a new codec or level, needs a real sample from an owner-approved live call.
- Where no maximum is documented, today's limit stays.
- When the request cannot bound the output, as with `auto` or a reference-following edit, Review states the limit: "Gallery saves images up to N megapixels. A completed billable image over that stays with the provider." The statement is bound into the digest.

### Video Save limits

Every shipped limit keeps its value and basis: Seedance 30 s (`provider`, and `upstream` for edit) and H3 Max 15 s (`provider`). A derived row needs one of two bounds:

- an output bound documented for its exact operation: the integer maximum of `duration` in that operation's schema branch, or the page's stated maximum
- the approved upstream fallback for a source-following operation: an uncontradicted cap of 60 s or less, with basis `upstream`

Otherwise the row is Review-only.

- `0`, `-1` and other unbounded durations are never offered.
- Resolution values match case-insensitively (`1080P` is 1080p) and are sent verbatim.
- A row without a resolution field needs a documented frame bound.
- `auto` and `adaptive`, for aspect or resolution, mean the output follows the input or the model's choice. They are offered only when a documented frame bound covers every outcome.
- Nominal frames must fit D6's limits as raised by G14.

## Shared ToAPIs inventory snapshot (G9)

One snapshot is kept per (provider, origin, scope `image` or `video`, credential revision). It holds `checked_at`, the outcome and the exact IDs that `GET /v1/models?type=<scope>` returned, and it is replaced atomically. ToAPIs documents the list as "models available to the current API key and user group".

- A model is **listed**, **absent** from a fresh snapshot, or **unknown**. Unknown covers no snapshot, a failed check, another credential revision, or a snapshot older than 24 hours.
- Only *listed* allows Queue.
- A failed check is recorded and blocks Queue until a later check succeeds.
- The Queue claim re-checks freshness and credential revision in its transaction.
- Each check carries the credential revision and a generation number. A late response is discarded.
- **Check again** is rate-limited to three checks a minute per scope. When Review opens on a stale snapshot, Siluet runs one automatic check, which is non-billable, within that limit.
- A listing is not evidence of entitlement, D4 compatibility or price.

The migration adds the snapshot table. `model_access` and the Seedream flag in the credential's authenticated data apply only until a snapshot exists for that (origin, scope, credential revision). Old records cannot become snapshots, because a single-model record would mark every other model absent.

## Coverage and the tag

`bun run catalog:coverage` expands every ledger key and option and gives each exactly one state:

- **verified**
- **contract-covered**, including rows on either D4 exception path
- **documented and pending**, with the missing class, construct or bound
- **provider unsupported**, with evidence
- **unknown**, with its open question

It prints tag-counting coverage separately. It also prints the **tag-blocking count**:

- pending pairs
- operations or options without a verified or contract-covered path
- unsupported pairs without evidence
- unknown pairs without a question

The tag needs that count at zero, unless the owner approves a scope change (D11). The [inventory](catalog-engine-inventory.md) is its first output. From G2a, CI regenerates it and fails on any difference.

The arithmetic under the revised D4: at `747e5d7`, the 162 in-scope entries split into 31 declared, 98 open and 33 closed. All three D4 paths count. Under the earlier rule, 131 entries could never count. At `ec73207` the split is 31, 98 and 44. The ledger expands to 648 documented keys (317 Poyo.ai, 331 ToAPIs), and 11 are verified. Engine slices cover 499, Phase 3 work covers 145, and 4 wait on evidence. 26 discovery-only IDs add no keys until their contracts are found. A key in an engine slice still counts as tag-blocking while its schema, class, Save bound or a D4 contradiction keeps it pending.

## Failure, unknown and stale cases

- **Schema outside the validator, an unqualified required input or no valid request.** The row is pending and Review names the reason. The adapter is never called.
- **Upstream drift.** The drift job fails, and app behaviour does not change until a re-pin. Removed rows stop queuing, and their claimed jobs finish from the stored contract.
- **Price basis missing or mismatched.** The rate is unknown, with unknown-price consent.
- **Inventory check fails, goes stale or answers late.** The model is unknown and Queue is blocked. A late answer is discarded.
- **Provider rejects the filtering field.** The rejection is confirmed after one POST, with no resubmission. Jobs says the provider refused the request.
- **Output Gallery cannot save** (type, animation, size, Save limit). The job completes and is held, with Retry download where D9 allows it. A truncated download is a failed download.
- **Poyo.ai 403 permission refusal.** That job is refused, and the key stays.

## Migrations

All are append-only and named at merge time (D3), and each has an upgrade test from a populated database.

- G1 rebuilds `gallery_image` for `image/webp`, keeping video constraints.
- G4 adds `image_job.contract` and the per-model refusal record.
- G9 adds the inventory snapshot table.
- G13 and G14 change Gallery limits only if a stored constraint encodes them.

## Project structure

- Derivation, drift, coverage and sources: `scripts/media-catalog/{derive,drift,coverage}.ts` and `sources/`.
- Browser-safe rows, descriptors, validator, rules and eligibility: `src/lib/shared/media-catalog/`.
- Wire mapping: the existing family adapters in `src/lib/server/providers/{poyo,toapis}/`. No provider calls another.
- Inventory storage and its service: `src/lib/server/db/` and `src/lib/server/services/providers/`.
- Browser journeys: `tests/browser/catalog-*.spec.ts`.

Logs and diagnostics redact every wire field typed `format: uri` or matched by a URL pattern, at any depth, not only the known fields.

## Boundaries

- **Always:** keep every row's source, date and quote; fail closed; run the [local checks](../README.md#development).
- **Ask first:** CI workflow changes (the weekly drift job); D4 or scope changes; any live call, including real samples for G14.
- **Never:** fetch a catalog or docs page at runtime; drop a field the provider accepts; resubmit after a rejection; widen a row beyond its evidence.

## Acceptance, offline with fixtures

Run `bun run --bun test`, `bun run --bun build` and `bun run --bun smoke`.

1. **Derivation.** It reproduces the committed rows byte for byte. The projection's SHA-256 matches its record, and a re-pin fixture verifies the upstream digest and projection.
2. **Validator.** Each supported construct, allowlisted pattern and reviewed rule has passing and negative fixtures. Unsupported constructs on required and optional inputs, a stale rule hash and a row with no valid minimal request each yield their stated state.
3. **Drift.** A fixture upstream with one model added, one removed, one enum changed and one billing changed makes `catalog:drift` fail and list all four. A changed descriptor, REST or model-list digest fails the same way, and an unchanged upstream passes.
4. **Queue conditions.** Failing any one condition alone blocks Queue with its message, zero POSTs and zero uploads.
5. **D4.** Every cell of the table has a fixture through the server guard (`submission.ts` and `services/queue/video.ts`):
   - The acknowledged path makes zero POSTs without the acknowledgement. With it, the body omits the field.
   - Disclosed paths send `false`.
   - Contradictions and refusals block.
   - Changed wording makes the Review stale.
   - A rejection fixture makes one POST, records a confirmed rejection and sends nothing more.
6. **Payload.**
   - The body validates with defaults applied.
   - `n: 1` is sent unless the default is 1.
   - Over-length prompts fail, in characters and in bytes.
   - URI fields are redacted in logs.
7. **Pricing.**
   - An exact match quotes and any other option is unknown.
   - An unchanged-digest re-pin keeps the rate, and a changed or missing basis makes it unknown.
   - An older build's decoder keeps a new kind as unquotable.
   - A quote that expires between Review and Queue goes stale.
8. **Claims.** A claimed job whose row a re-pin removed still recovers and saves. A stale consent transfers zero bytes.
9. **WebP and formats.**
   - Offered values are sent verbatim, and `gif` is never offered.
   - Lossy and lossless still WebP save, reopen offline, serve `image/webp` and download as `.webp`.
   - Animated, padded-wrong, trailing-byte and multi-page WebP and GIF are held. Truncated WebP retries as a failed download.
   - An upgrade keeps every Gallery row and video constraint.
10. **Sizes and video.**
    - Before G13 and G14, over-limit values are gaps. After, they are offered within the measured budgets.
    - Video rows take their limit per operation. Unbounded durations and unbounded `auto` are never offered.
    - Resolution matching is case-insensitive.
11. **Inventory.** Fixtures cover listed, absent, failed, stale, revision change, a late response and two concurrent checks. Only a fresh *listed* entry queues. The claim re-reads it, and replacement is atomic.
12. **Review.** It names the verified model, schema revision and date, and "not individually tested". A Poyo.ai 403 fixture refuses one job and keeps the key.
13. **Qualification.** Each new class passes the seven family fixtures and one built-app journey to verified Save and offline reopen.
14. **Coverage.** `catalog:coverage` gives every expanded key and option exactly one state. Its tag-blocking count matches the ledger, and the inventory regenerates unchanged.

## Slice plan

Slices merge in table order, and each is independently mergeable. The numbers are the round-1 names. G9 can run alongside G3–G8b, and G13 and G14 alongside the slices before them. Every slice lands before the tag. Each qualifying slice includes a built-app journey from Queue to Save on a derived row.

| Slice | Creator-visible outcome | Verification |
| --- | --- | --- |
| G1 Still WebP Save | A WebP result saves, reopens offline and downloads as `.webp`; animated WebP and GIF are held. | Check 9; migration upgrade test. |
| G2a Derivation and coverage | Contributors get derived rows, the validator and `catalog:coverage` with its tag-blocking count, all offline. | Checks 1, 2 and 14. |
| G2b Picker | The picker lists every derived row as Review-only with its reason. | Picker journey. |
| G2c Re-pin | Data only: projection, ledger and price feed move to the newest head together, with the diff, and the D2 baseline is re-dated. | Checks 1 and 14. |
| G2d Drift job | The weekly online drift check runs (CI change, owner approves). | Check 3. |
| G3 Per-model formats | Image Review offers each model's own formats and shows the expected type; Seedream moves onto the same path. | Check 9. |
| G4 Poyo.ai text-to-image | Declared and open-schema image rows queue, with the D4 disclosure where open, estimates or unknown-price consent, and the access note; 403 keeps the key. | Checks 4–8 and 12; migration test. |
| G5 Poyo.ai image edits | The same rows edit with 1–10 ordered URLs or local JPEG/PNG, then more than 10 as its own class. | Check 13. |
| G6 Acknowledged image rows | Closed-schema image rows queue after the acknowledgement (gpt-image-2.5/2.6, Ideogram, Kling image, MAI and others). | Check 5. |
| G13 Gallery image limits | 4K tiers and large explicit sizes save, within a measured decode budget. | Check 10; budget test. |
| G7 Poyo.ai text-to-video | Poyo.ai video rows queue with data Save limits, including closed-schema rows after the acknowledgement. | Checks 5 and 10. |
| G8 Poyo.ai frames | First and first-and-last frames qualify on H3 Max, then derived rows follow with reviewed role notes, including `start_image_url`/`end_image_url`. | Check 13. |
| G8b Poyo.ai image references | `reference_image_urls` qualifies on H3 Max, then derived reference-to-video rows follow. | Check 13. |
| G14 Gallery video limits | 1080p, 2K and 4K clips save within measured budgets; new structures only after an approved real sample. | Check 10; real-clip check. |
| G9 Inventory snapshot | Settings and Review show listed, absent or unknown per exact ToAPIs model, with Check again. | Check 11; migration test. |
| G10a ToAPIs text-to-image | Admitted ToAPIs image rows queue with disclosure and unknown-price consent; pages without a linked status route stay Review-only. | Checks 4–6 and 13. |
| G10b ToAPIs image edits | The same rows edit with ordered references, including more than 10 where documented (`gpt-image-2`: 14). | Check 13. |
| G11a ToAPIs text-to-video | The adapter serves every admitted exact ID; text-to-video rows queue. | Checks 5, 10 and 13. |
| G11b ToAPIs frames | First and first-and-last frame rows queue. | Check 13. |
| G11c ToAPIs reference generation | Image-reference and one-reference-video rows queue, qualified apart from edit. | Check 13. |
| G11d ToAPIs source edit | Admitted non-Seedance video-edit rows queue with an upstream or documented bound. | Checks 10 and 13. |
| G12 Engine reconciliation | Every engine-scope pair has its final state, and the engine's share of the tag-blocking count is zero or each remainder has an owner question. | Check 14; recount recorded in the ledger. |

**Bespoke work outside the engine, for Phase 3.** Each needs a new class or contract on its family representative, then joins as data. The [inventory](catalog-engine-inventory.md) counts each:

- layer decomposition: Poyo.ai `seedream-5.5-layerize`, ToAPIs `layer_decomposition`
- audio and avatars: `reference_audio_urls`, `audio_url`, driving-audio and public-avatar operations (HeyGen, Kling Avatar, OmniHuman, `sync-lipsync-3`)
- video and mixed references: multimodal, image-and-video, subject-and-motion and subject-and-media references
- positioned and multi keyframes; draft and draft-to-final chains; multi-shot
- source-video work on Poyo.ai: edit, video-to-video, motion, character replacement, upscaling, background removal, translation (Review-only at 360 s)
- video extension, the ToAPIs `/v1/videos` envelope and remix routes, and Midjourney actions
- masks, markup and localized edits; multi-output and image sets; GIF and SVG output
- music-task prerequisites (`generate-music-cover`, `create-music-video`)
- local MP4, WAV and other formats (Uploads 1 and 2)

Long, webpage and e-commerce images and image translation stay in the engine. They join G4, G5 or G10 once G13 covers a documented output bound, and translation once its target-language option is qualified.

## Open questions

For the owner:

1. **Closed-schema rows.** The orchestrator recorded in D4 (PR #72) that the 33 closed-schema entries (44 at `ec73207`) count toward the tag on the acknowledged omit path. A council seat reviewing PR #72 read the owner's answer as covering only models where the field can be sent. *Recommendation:* count them. Otherwise they can never count, and the tag needs a scope change.
2. **ToAPIs prices for derived rows.** Unknown-price consent now, or a ToAPIs v3 feed that older builds ignore. *Recommendation:* consent now, and decide the v3 feed after G11.
3. **Video above 64 MiB.** Browser-key sessions buffer clips up to 64 MiB ([D1](decisions.md#browser-credential)). G14 raising the byte cap also needs a streaming or larger-buffer decision, and new codecs or levels need owner-approved live samples. *Recommendation:* approve one cheapest call per new structure when G14 measures one.
4. **ToAPIs image pages that do not link the status route.** Under the ruling these rows are Review-only, and their number is unknown until G10a reads every page. *Recommendation:* keep the rule, and ask ToAPIs to link the generic route.
5. **Explicit D4 refusals.** None are known yet. Any found would need a D4 decision before it counts.

## Unverified

- Which ToAPIs pages link the image status route and document `client_business_id`.
- Whether undocumented filtering fields have any effect on either provider.
- Actual output dimensions per tier and ratio, delivered types when a format is requested, and the largest outputs and decode costs G13 and G14 must measure.
- Per-key Poyo.ai entitlement.
- Whether ToAPIs' Markdown pages are stable enough to hash without false drift.

## Sources

- PoYo capability catalog at [`747e5d7`](https://github.com/PoyoAPI/poyo-devtools/blob/747e5d75319585d66396a3c05bd1b97d9390ce74/artifacts/capability-catalog.json) (committed 2026-11-19) and [`ec73207`](https://github.com/PoyoAPI/poyo-devtools/blob/ec7320720913a55f955e1bf6a651e9c38bd356c5/artifacts/capability-catalog.json) (2026-11-26, the upstream head on 2026-11-26), compared with `c89a6a4`. Fetched 2026-11-26.
- [PoYo docs index](https://docs.poyo.ai/llms.txt) and sampled REST pages (Nano Banana 2, 2 New, 2 Lite and Kling 3.0), accessed 2026-11-26.
- ToAPIs [model list](https://docs.toapis.com/docs/en/api-reference/chat/list-models), [image status](https://docs.toapis.com/docs/en/api-reference/tasks/image-status), [GPT Image 2](https://docs.toapis.com/docs/en/api-reference/images/gpt-image-2/generation), [Seedream 5.5](https://docs.toapis.com/docs/en/api-reference/images/seedream-5.5/generation) and [Seedance 2.5](https://docs.toapis.com/docs/en/api-reference/videos/seedance-2-5/generation), accessed 2026-11-26. The [public catalog](https://docs.toapis.com/docs/en/api-reference/models) snapshot is dated 2026-11-10.
