# Catalog engine · V1

**Revision 7, 2026-11-26. Approved for slice-by-slice implementation after six council rounds (2026-11-26).** Applies the round-6 text fixes and keeps the owner's answer on sizes: support whatever the providers support. Implements Models 1 in the [capability map](SPEC.md#remaining-deliverables-and-release-checks) under [D2](decisions.md#verification-by-contract-family), [D4](decisions.md#d4--optional-filtering-on-media-requests), [D5](decisions.md#d5--verify-gallery-images-before-saving) and [D6](decisions.md#d6--verify-downloaded-video-structure-in-typescript), on top of the [media catalog](SPEC-media-catalog.md) and [per-mode Save limits](SPEC-video-save-limits.md). v0.1.0 waits for full D2 coverage ([D11](decisions.md#d11--v010-waits-for-full-d2-coverage)). Every slice here lands before the tag. The [remaining-work inventory](catalog-engine-inventory.md) assigns each pair to a slice or a question.

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

- **Request:** the pinned catalog schema and the model's OpenAPI spec (Poyo.ai), or the model's page (ToAPIs).
- **Acknowledgement:** the documented submit response.
- **Recovery:** the family's verified recovery, unchanged.
  - Poyo.ai: no correlation. Job code tells the kind, as for H3 Max.
  - ToAPIs image (verified Seedream): no correlation is sent. A lost acknowledgement leaves the job uncertain, and it is never resubmitted. Image jobs never set `business_id`, because `image-job-store.ts` reads it as the video marker.
  - ToAPIs video (verified Seedance): `client_business_id` on the row's route.
- **Status route:** Poyo.ai's shared `GET /api/generate/status/{task_id}`. A ToAPIs image page must name or link the generic `GET /v1/images/generations/{task_id}` ([image status](https://docs.toapis.com/docs/en/api-reference/tasks/image-status)). Seedream 5.5's page names it in its curl example. The `gpt-image-2` page does neither, so that row is Review-only.
- **Result:** the documented completed envelope with a media URL.
- **Save:** an output that D5 or D6 verifies.

`service_type` and `execution_mode` are part of the evidence. All 173 in-scope entries at `ec73207` (162 at `747e5d7`) read `generate` and `async`, and a row that differs is pending.

| Family | Representative | Qualified classes today | Added here, with the model that qualifies each |
| --- | --- | --- | --- |
| Poyo.ai image, `POST /api/generate/submit`, D5 | `seedream-5.5`, `z-image` | prompt; enum options; `output_format` png/jpeg; 1–10 ordered public URLs in `image_urls`; local JPEG/PNG | boolean (`prompt_extend`) and integer (`seed`) on `qwen-image-2.1` (G4); free text: question 6; 11–16 ordered URLs on `minimax-h3-image` (G6b); still WebP (G1) |
| Poyo.ai video, same route, D6 | `h3-max` | prompt; enum options; integer `duration` | boolean (`audio`) on `wan3.0-text-to-video`, free text (`negative_prompt`) on `wan2.5-text-to-video` (G7); frames (G8) and `reference_image_urls` (G8b) on `h3-max`; number: question 3 |
| ToAPIs image, `POST /v1/images/generations`, D5 | `doubao-seedream-5-5` | prompt; `size`; 1–10 ordered public URLs; local JPEG/PNG; `metadata.output_format` | other exact IDs (G10a); output format, boolean and integer options, each qualified on the first admitted row that carries it (G10a); up to 16 references on `minimax-h3-image` (G10b) |
| ToAPIs video, `POST /v1/videos/generations`, D6 | `seedance-2-5` | prompt; duration, resolution, ratio; `first_frame` and `last_frame`; one `reference_video` for edit | other exact IDs (G11a); frames on them (G11b); image references, frames with image references and one reference video for generation (G11c, on the first admitted row of each); source edit on other IDs (G11d) |

A qualifying model is promoted to **verified** for its class: the seven D2 fixtures and one built-app journey from Queue to verified Save and offline reopen. The ToAPIs video adapter now accepts only `seedance-2-5` in its task envelope (`toapis/video.ts`). G11a generalizes it to the row's submitted ID. A page whose response names another model, such as MiniMax-H3's, needs a reviewed rule that states which model name the response must carry. Subjects and non-URL characters (`sora-2-vvip` personas) are Phase 3.

Verified representatives keep their reviewed descriptors. The deriver cross-checks them and fails on any disagreement, but never rewrites them. The engine reads no wire name as a role. Only reviewed **family conventions** do, each with its quote:

- `image_urls` as ordered image references on Poyo.ai images (Seedream 5.5: "Optional 1–10 reference image URLs").
- `n` as output count where its description begins with "Number of output images" or "Number of images to generate". At `747e5d7` that covers every in-scope `n` but `ideogram-vector-1.0/text-to-vector` ("Output count, from 1 to 8") and `kling-4.0-image` ("Number of images. When enable_sequential is false: 1–9"), which each need a reviewed note. Any further sentence that constrains `n` needs a reviewed rule. For example, `seedream-4` says "The total of image_urls plus n must not exceed 15", and its `image_urls` keeps `maxItems: 10`, so the rule allows `min(10, 15 − n)` references: 10 with `n: 1`.
- `duration` as output seconds where the schema or page says so (H3 Max: "`duration` is an integer from 5 through 15 seconds").

Any other mapping needs a reviewed note that quotes the provider. A row whose operation needs an unqualified input stays pending and names the class.

**One output per request.** Siluet sends `n: 1` only where a documented count field accepts 1. Without a count field, the row needs evidence that its mode returns one output: a schema, page or result envelope that says so for that mode. Seedream 5.5 has no `n`: its Poyo.ai schema says "Generate one image", and its ToAPIs page says "Ordinary generation returns one image". Otherwise the row is pending. Derived rows start at one request and zero retries. A completed result with more than one image is held in Jobs, and nothing from it is saved.

Each new representative has that evidence for the mode it qualifies:

- `qwen-image-2.1` text-to-image: "The Qwen Image 2.1 API generates one image from text" (OpenAPI `info.description`). It replaces `qwen-image-3`, whose schema, OpenAPI spec and page state no output count.
- ToAPIs `minimax-h3-image` edit, for more than 10 references: `n`, "Number of images to generate, range 1-10", sent as 1. The page accepts "up to 16" reference URLs and names `GET /v1/images/generations/{task_id}`. It does not say that order matters, so Review promises no order. Its wire shape follows a reviewed rule bound to the page's hash. In ratio and `auto` modes Siluet always sends `resolution`, so the unseen `4K` default never applies. With an explicit `WxH` `size` it sends neither `resolution` nor `aspect_ratio`, because "Explicit pixel `size` cannot be combined with `resolution` or `aspect_ratio`, even when they are `auto`". The negative fixture sends an explicit `size` with `resolution`. 4K tiers and explicit sizes over Gallery's limits wait for G13.
- Poyo.ai `minimax-h3-image` edit, for 11–16 references (G6b): its closed OpenAPI input says "Generate one image. With image_urls, edit or combine the reference images." A reviewed note reads that input-level sentence as covering both modes. Its `image_urls` says "Images are numbered by their order in the array", so Review may promise order on this row. The same reading is declined for `gpt-image-2.5-fixed`, `-2.5-flare`, `-2.5-sunburst`, `-2.6-fixed`, `-2.6-flare` and `-2.6-sunburst`. Their inputs say "Generate one image, or edit reference images when image_urls is non-empty" (`gpt-image-2.5-fixed`'s: "or use reference images"), where "one image" belongs to generation only. The `-fixed` OpenAPI inputs state no output count. Their edit modes stay pending at any reference count, with [question 9](#open-questions).

**More than 10 Poyo.ai references.** A request carries at most 10 local files, one full window of the 10-uploads-per-60-s limit (`poyo-upload-window.ts`). Any references beyond them must be public URLs. G6b qualifies the class on Poyo.ai `minimax-h3-image` with 11 and 16 references, at most 10 of them local. With more than 10 local files, Review names the limit and offers no Queue: "Poyo.ai takes at most 10 uploaded files in one request. Replace N of them with public image links." Queue then sends nothing and uploads nothing. Its billing is quoted as an unknown price, because its formula counts references (`reference_image_count * input_image_credits`).

## Deriving and validating rows

**Poyo.ai.** The capability catalog ([`747e5d7`](https://github.com/PoyoAPI/poyo-devtools/blob/747e5d75319585d66396a3c05bd1b97d9390ce74/artifacts/capability-catalog.json), 2026-11-19, sha256 `eebbc67…`) holds 252 entries. 162 are in scope: those whose category gives an image or video result, plus the two music-prerequisite IDs. G2c re-pinned to the newest head on 2026-11-27 ([`ec73207`](https://github.com/PoyoAPI/poyo-devtools/blob/ec7320720913a55f955e1bf6a651e9c38bd356c5/artifacts/capability-catalog.json), 2026-11-26, sha256 `844ed1d…`, 266 entries, 173 in scope), and the [inventory](catalog-engine-inventory.md#re-pin-to-ec73207) records its evidence diff. G2c lands before G4, so every queueing slice derives from `ec73207`. After that, a re-pin lands only when `catalog:drift` reports a change.

**Re-pins.** Every re-pin, G2c included, is one reviewed "data and rules" PR. It shows the evidence diff, re-binds or retires every reviewed rule and override whose hash it makes stale, and shows the resulting coverage and tag-blocking diff. It re-dates the D2 baseline and moves the v2 price feed to the same revision. G12 freezes the D2 baseline. After G12, any re-pin before the tag reopens G12's recount. Otherwise the tag uses the frozen revision, and the release notes record the drift since then.

`scripts/media-catalog/sources/poyo-<rev>.json` holds a deterministic projection of the in-scope entries: `model_id`, `category`, `status`, `service_type`, `execution_mode`, `input_schema` with descriptions, and `billing`. It is canonical compact JSON (sorted keys, no whitespace), about 313 KB, under the 500 KB hook. `biome.json` adds `!!scripts/media-catalog/sources` and `!!src/lib/shared/media-catalog/poyo-rows.json` to `files.includes`, so formatting never expands them. The upstream revision, upstream SHA-256, projection SHA-256 and MIT notice sit beside it.

**Poyo.ai OpenAPI specs.** The "OpenAPI Specs" section of the [docs index](https://docs.poyo.ai/llms.txt) lists one spec per model page. On 2026-11-26 the index lists 175 files, and 147 English specs cover 210 IDs, including 157 of the 162 in-scope entries at `747e5d7`. The five without a spec are discovery-only. At `ec73207` the specs cover 160 of the 173: the eight added LTX, Recraft and Sync IDs have no spec and take the catalog's state alone. G2a writes `scripts/media-catalog/sources/poyo-openapi-<date>.json` in the same canonical form. It holds:

- the index digest and a manifest of all 175 listed files with their SHA-256
- for in-scope IDs only, the model's own resolved `input` schema, stored once per distinct schema and keyed from each ID

Local `$ref`s are resolved, and a remote `$ref` fails the projection. The projection keeps `example` and `examples` keys, because reviewers quote them. A throwaway measurement on 2026-11-26 found no remote `$ref` and 95 distinct input schemas for the 157 IDs, about 192 KB with examples. At `ec73207` it found 98 schemas for 160 IDs, about 198 KB with examples. A test keeps the file under the 500 KB hook. G2c re-projects with the re-pin. The [inventory](catalog-engine-inventory.md#poyoai-openapi-specs) records the digests and counts.

`bun run catalog:derive` turns both projections, the ledger and reviewed overrides into `src/lib/shared/media-catalog/poyo-rows.json`. A test keeps it under the 500 KB hook, and a build check keeps the client bundle within a recorded budget. The app never fetches a catalog at runtime.

**ToAPIs.** ToAPIs publishes no schema. Each docs page gets one descriptor, `src/lib/shared/media-catalog/toapis/<page>.ts`, with:

- exact IDs, route, status route, recovery and operations
- every documented field, sent or not: wire name, kind, range or enum, default and quote
- the D4 state, output formats, the Save bound with its quote and the rate key
- the page URL, access date and SHA-256 of its Markdown rendering

**Validation.** Queue validates the serialized body it will send, including `n`, the D4 field and media URLs. It adds no defaults before validating. A Poyo.ai body is valid only against both the catalog schema and the model's OpenAPI `input`. A row without an OpenAPI spec validates against the catalog alone. Where one source is closed, a field that only the other lists is a contradiction for that option: it is never offered, and its state is unknown with question 7. The negative fixtures are `gpt-image-2.6-fixed` with `resolution` and `poyo-ai/image-translator` with `protect_text`, `synthesis_on_image` or `translate_on_image`. Beside each sits an omitted-field fixture that passes. `gpt-image-2.6-fixed` without `resolution` validates even though the catalog gives it `default: "1K"`.

**Effective defaults** are resolved separately for Review, pricing and Save. The applicable sources are the catalog schema and the OpenAPI input for a Poyo.ai row with a spec, the catalog alone for a row without one, and the page for ToAPIs. An omitted field takes its documented default only when every applicable source lists the field and all agree on the default. A field that one source lists and another omits has an unknown default. A default that is missing, disputed or unknown is unresolved.

**Unresolved defaults.** When a creator-selectable field's effective default is unresolved and the merged schema accepts the field, the composer preselects an explicit value from the shared domain and sends it. That value counts as the creator's choice, so Review, the price and the Save bound follow it. The default rule applies only to fields Siluet omits. If an omitted field's unresolved default affects Review, the price or the Save bound, Review says "provider default, not documented", and the price is unknown. An image row's Save then uses the stated Gallery limit with the [Review statement](#gallery-size-limits), and a video row whose Save bound depends on it stays Review-only. For example, `gpt-image-2.6-fixed`'s output tier is unknown: only the catalog lists `resolution` and its `1K` default, and the closed OpenAPI input does not accept the field, so Siluet omits it.

**Disputed domains.** Where both sources list a field with different limits, values in the shared domain stay eligible. The disputed values are an explicit coverage gap: `catalog:coverage` reports them as unknown with both quotes, and the [inventory](catalog-engine-inventory.md#disputed-domains) lists them. For example, `seedream-4.5` `n` is 1–15 in the catalog and 1–6 in its OpenAPI input. The engine's fixed `n: 1` is unaffected. Each value takes one state: 2–6 are Phase 3 multi-output obligations, and 7–15 are unknown with [question 8](#open-questions).

`src/lib/shared/media-catalog/schema.ts` is an in-repo validator for the constructs the catalog and the OpenAPI specs use:

- `type`, `properties`, `required`, `additionalProperties`, `enum`, `default`, `minimum`, `maximum`, `minLength` and `maxLength`
- arrays with `items`, `minItems` and `maxItems`, and `format: uri`
- `allOf`, `not`, `if`/`then`/`else`, and `anyOf` whose branches are `required` lists or `properties` with `required`
- `pattern`, from an allowlist only. That holds `\S`, `^https?://`, `^https?://\S+$` and `^\d+x\d+$`. The validator runs the pattern on the value.

`oneOf`, `contains`, `const`, `x-*` keys, nested objects, untyped properties and every other pattern are outside it. At `747e5d7` the other patterns are the `size` patterns of `gpt-image-2.5` and `2.6` Flare and Sunburst and of `mai-image-2.6` and `2.7` with their Flash IDs, the `WIDTHxHEIGHT` branch of the `seedream-4.5` and `seedream-5.0-lite` `size` `oneOf` and their edit IDs, and `ideogram-v4.5-edit`'s `size` and `data:image` URL patterns. Fourteen entries use `oneOf` and five use `x-server-validation` (see the [inventory](catalog-engine-inventory.md#option-classes-in-the-pinned-schemas)). The OpenAPI specs add `const`, `minProperties` and `maxProperties` in two specs each. A `discriminator` on `model` in two specs only selects each model's branch. Such a construct keeps the row pending if it touches a required input or the whole schema. Otherwise that option has no covered path yet.

A **reviewed rule** expresses one cross-field constraint, quotes it and records the SHA-256 of the schema it was checked against. A reviewed **override** may only narrow a row. Either goes stale when the hash changes, and every construct and rule has a negative fixture. If no valid minimal request exists (prompt, required inputs, defaults), the row stays pending.

**Patterned sizes.** A `WxH` value matching a schema pattern is offered only under a hash-bound rule for the provider's dimension range, divisibility, aspect and tier constraints. `flux-3-klein` is the model case. Its `size` is exactly `oneOf` [an enum of seven ratios, `pattern: ^\d+x\d+$`], and its schema says "Custom dimensions must each be 256-4096, divisible by 16, and accompanied by an explicit matching resolution", where the long edge selects 1K, 2K or 4K. The rule replaces that exact `oneOf` and validates both branches: a listed ratio passes the enum, and explicit dimensions pass the pattern and then the range, divisibility and tier checks. Its tests cover a listed ratio, an unlisted ratio and explicit dimensions with the wrong tier. Without such a rule, only the listed ratios are offered.

Each family outside the allowlist gets its own hash-bound typing rule with the provider's checks. Siluet sends canonical `WxH`, never the whitespace or `X` the patterns tolerate. Each rule's tests cover a listed value, an unlisted one and explicit dimensions that fail each check.

- **`gpt-image-2.5` and `2.6` Flare and Sunburst (G6).** The listed ratios and `auto`, or custom sizes "divisible by 16, max edge 3840, aspect ratio at most 3:1, and total pixels 655360–8294400". The billed tier follows total pixels ("up to 1572864 is 1K, up to 4194304 is 2K, larger is 4K"), or the selected `resolution` if it is higher.
- **`mai-image-2.6` and `-flash` (G6).** The listed ratios, or custom sizes with "both sides divisible by 32, each side at least 768, and total pixels at most 2359296". `resolution` does not apply to them. `size` is "Ignored when image_urls is provided", so edit rows never send it.
- **`mai-image-2.7` and `-flash` (G6).** The listed ratios, or custom sizes with "both sides divisible by 16, each side at least 768, and total pixels at most 4194304", "used exactly as given". Edit rows may send it. Without it, "the output follows the aspect ratio of the first reference image at about 1 megapixel".
- **Ideogram: `ideogram-v4.5-edit`, `ideogram-v4.6` and `ideogram-v4.6-edit` (G6).** One rule per ID, each bound to that schema's hash. All three take `auto` and the listed values, or explicit sizes:
  - `ideogram-v4.5-edit`: "Minimum dimension 256; multiples of 32; at most 4194304 pixels; aspect ratio at most 6:1", only on "an unmasked regular edit".
  - `ideogram-v4.6`: "sides of 256-4096 pixels, multiples of 32, and an aspect ratio within 1:6 and 6:1". "Sizes above 4194304 pixels use the 4K price and do not support very_low", so the rule refuses `quality: very_low` there, and the price follows the 4K tier.
  - `ideogram-v4.6-edit`: the same checks as `ideogram-v4.6`, and non-`auto` sizes "are only allowed for regular edits without mask_url".

  On the edit IDs the rule replaces the schema's top-level `allOf`, including `size: auto` under a mask or `edit_precision: high`, at most three `reference_image_urls` with a mask, and `ideogram-v4.6-edit`'s `background` and `context_window` branches. With any explicit size, Siluet sends `edit_precision: "regular"` explicitly. URL fields take only the `https?://\S+` branch, and Siluet never sends a `data:image` URI, because local files go through Poyo.ai uploads. The rule still checks the stricter `data:image/<type>;base64,` form on `ideogram-v4.6-edit`. Explicit sizes whose output exceeds Gallery's limits wait for G13.
- **`seedream-4.5` and `seedream-5.0-lite`, with their edit IDs (G4, G5).** The rule replaces the `oneOf`. The enum branch passes as listed, and G4 offers every listed value except `seedream-4.5`'s `4K`, which waits for G13. Neither source documents a dimension range or tier for the `WIDTHxHEIGHT` branch, so custom sizes are unknown with [question 11](#open-questions). The object branch is a nested object and is never sent.

At `ec73207`, `ideogram-v4.6` and `-edit` carry the same kinds of pattern. G2c only records them as data in the inventory's [constructs list](catalog-engine-inventory.md#option-classes-in-the-pinned-schemas), and G6 writes their rules.

**Prose-only domains.** A string option that is not free text and whose domain appears only in prose, with no `enum`, `pattern` or `format`, is offered only through a hash-bound reviewed rule that types it, with its negative fixture. Without one, the option has no covered path, and Siluet omits it from the body. Where no source documents the domain at all, the option is unknown with [question 11](#open-questions). Examples are the `size` of Poyo.ai `minimax-h3-image`, whose rule lands with G6, and of `gpt-image-2` and `gpt-image-2-edit`. The [inventory](catalog-engine-inventory.md#prose-only-domains) lists every such row. A ToAPIs descriptor types each field from its page with a quote, and the page hash binds it in the same way.

**Prompt and free-text limits.** Each derived row takes the limit that its schema (`maxLength`) or page states for `prompt` and for each free-text option, in that limit's own unit. `maxLength` counts Unicode code points, as JSON Schema does. The composer offers the whole documented limit. The owner asked on 2026-11-26 for Siluet to support whatever the providers support, so raising a composer cap to a documented limit needs no further decision. So `gpt-image-2.6-fixed` takes its 32,000, Z-Image keeps its 1,000, and `h3-max` rises to its documented 50,000 characters with G7. A smaller limit stated for one operation applies to that operation, such as `pixverse-v6-max`'s "2048 characters for image-to-video" under its schema's 5,000.

**Comparison rule.** Where the transport is byte-limited, as Siluet's video request is (`video-studio/request.ts` counts UTF-8 bytes), a documented limit of L code points is checked as at most L code points and at most 4L UTF-8 bytes. One code point takes at most four bytes, so the byte check never refuses text within the documented limit. `h3-max` thus allows 50,000 code points and 200,000 bytes.

**Where schema and page are silent**, Siluet's own envelope applies, and Queue enforces it:

- Video: 4,000 UTF-8 bytes. It is a release choice made for the [first saved video](SPEC-first-saved-video.md#submit-and-track) composer, not a provider limit.
- Image: 5,000 code points, the shipped Poyo.ai image limit (`poyoPromptLimits`, Seedream 5.5's documented limit).

G2a reads each model page before it assigns question 10 to a row. Coverage reports free text on rows whose page is silent as unknown with [question 10](#open-questions), "prompt limit not documented". The [inventory](catalog-engine-inventory.md#prompt-limits) lists them, including every row that stays byte-limited. A ToAPIs descriptor records its page's limit in the same way. Verified ToAPIs `seedance-2-5` keeps 4,000 bytes until G11a records its page's limit or the question.

**Drift.** At a re-pin, `catalog:drift --repin` checks that the fetched upstream file matches its recorded SHA-256 and that projecting it reproduces the committed projection byte for byte. The offline checks verify the projection's recorded SHA-256 and regenerate the rows, failing on any difference. Run weekly and online, `catalog:drift` compares the projection with the upstream head. It also compares the digest of every source that controls eligibility: the [docs index](https://docs.poyo.ai/llms.txt), each OpenAPI spec it lists, each REST page behind a reviewed state, each ToAPIs descriptor page and the ToAPIs model list. It fails with an evidence diff, and app behaviour changes only through a reviewed re-pin.

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

Siluet sends the filtering field on every model, documented or not, unless the schema forbids it (D4, revised 2026-11-26). The REST column comes from the model's OpenAPI spec. Each row takes one ledger state:

| Pinned catalog | REST declares the field | REST input closed without it | REST open, says filtering is fixed | REST open without it, or no spec |
| --- | --- | --- | --- | --- |
| declares `enable_safety_checker` | declared | contradiction | contradiction | declared |
| closed schema without it | contradiction | closed-absent | closed-absent | closed-absent |
| open schema without it | declared | closed-absent | open-absent, fixed | open-absent |

When the REST input is closed, the closed column applies even if the page also says filtering is fixed.

- **declared:** send `false`.
- **closed-absent:** omit the field after the acknowledgement.
- **open-absent:** send `false`, with the disclosure. *Fixed* takes its own disclosure.
- **contradiction:** blocked.
- **refused:** a page that explicitly refuses the field or `false`. Blocked, except where the row is closed-absent and already omits the field.

**Engine ruling, 2026-11-26.** Where the catalog and Poyo.ai's API schema disagree on whether the input is closed, the stricter schema wins. This is the engine's reading of D4 as revised on 2026-11-26, recorded here and not in `decisions.md`.

**Other safety-related fields are ordinary options.** Only the fixed flag is a D4 field. The owner ruled on 2026-11-26 that Poyo.ai `moderation` (`auto`, `low`) on `gpt-image-2.6-flare` and `gpt-image-2.6-sunburst` is an ordinary creator option. It is offered with its documented domain, like any enum, and those rows can leave Review-only once the other conditions hold.

A blocked row is Review-only and counts as tag-blocking until the owner decides. The REST state is mechanical from the projected spec, whose SHA-256 drift watches. *Fixed* also needs a reviewed quote from the spec or page. Only a row with no OpenAPI spec takes the catalog's state alone, and Review says so: "Siluet read this from Poyo.ai's catalog. This model's API page was not reviewed." At `747e5d7` no documented row is in that case. At `ec73207` the eight added IDs without a spec are. ToAPIs descriptors record declared, open-absent (unconfirmed) or refused. Rows not yet derived keep the ledger default `unknown`, which blocks Queue.

**ToAPIs `minimax-h3-image` is open-absent** (council round 4, two of three seats). It queues with the bound ToAPIs disclosure, and a rejection after its one POST is kept as a confirmed rejection. The page's unsupported-parameter list omits `disable_nsfw`. Its closing sentence, "Do not apply parameters or defaults from other image models", is a generic warning, not a published schema. The owner's rule sends the field wherever no published schema forbids it. The closed-absent reading was declined for these reasons.

**Ledger migration (G2a).** Counted by exact model ID with the query in the [inventory](catalog-engine-inventory.md#d4-states-after-the-ledger-migration), the 159 documented Poyo.ai IDs hold 39 marked `conflict` today (37 by `d4`, the two Gemini Omni Flash IDs by `catalogD4`), 31 declared and 89 with neither. They become 39 closed-absent, 31 declared and 89 open-absent, and the inventory lists each conflict row with its evidence. The fields change as follows:

- `d4` holds one state from the table, or `unknown` before derivation.
- `catalogD4` becomes optional and survives only as `conflict` beside `d4: contradiction`, naming the catalog as the contradicting source. G2a drops its `declared` and `unknown` values, because the table derives them. That covers one ledger row with `declared`, four with `unknown`, and the registry's `seedreamEvidence`, `zImageEvidence`, Seedance and H3 Max evidence. The shipped `submission.test.ts` fixtures move to the new states.
- `scripts/media-catalog/coverage.ts` and `ledger.test.ts` count one key per primary route, so a route alias no longer counts twice.

G2a also updates `queueEvidenceProblem` and the D4 bullet in the [media catalog spec](SPEC-media-catalog.md). The guard blocks contradiction, refused and `unknown`. It requires the bound acknowledgement for closed-absent and the bound disclosure for open-absent. G2a puts it at every call site: `services/queue/submission.ts`, `services/queue/video.ts` and `services/file-edit/queue.ts`. It also changes both call sites in the browser's `ImageReview.svelte`: the `unavailable` check that decides whether Queue is offered, and the route-evidence note. That note says the model contract "declares" the field only when `d4 === "declared"`. Offline fixtures exercise the changed guard against each of the eleven shipped operations, including local-file edits, and each new D4 state.

Exact wording, each part of the Review digest:

- **Acknowledgement**, for closed-absent. It names the sources that close the input: "Poyo.ai's API schema", "Poyo.ai's catalog schema" or "Poyo.ai's catalog and API schemas". For example: "Poyo.ai's API schema for this model has no `enable_safety_checker` field and allows no fields it does not list, so Siluet sends this request without it. Filtering is up to Poyo.ai. I understand."
- **Poyo.ai disclosure**, for open-absent: "Poyo.ai does not document `enable_safety_checker` for this model. Siluet sends `enable_safety_checker: false` anyway. Whether Poyo.ai accepts it or applies it is unverified. If Poyo.ai rejects the request, Siluet does not resend it without the field."
- **Fixed disclosure**, for open-absent where the API page says filtering is fixed: "Poyo.ai's API page says filtering for this model is fixed. Siluet sends `enable_safety_checker: false` anyway. Whether Poyo.ai accepts it or applies it is unverified. If Poyo.ai rejects the request, Siluet does not resend it without the field."
- **ToAPIs disclosure:** the Poyo.ai disclosure, with "ToAPIs" and `disable_nsfw`.
- **ToAPIs fallback note**, shown separately on a row whose page documents a conditional fallback, such as `wan3.0-video`: "ToAPIs says `disable_nsfw: false` enables its fallback only for eligible accounts and regions. Siluet cannot check whether this key is eligible." The note says nothing about whether the field is accepted.

A provider rejection keeps its original request and is never resubmitted.

### Pricing

A price applies only on an exact match of operation, resolved options, billing unit and reference counts, within D1 freshness. Resolution matches case-insensitively, as Save does (`1080P` is 1080p). Anything else is unknown. The collector evaluates `fixed`, `tiered` with a known formula string, and `parameterized` without reference tokens. `dynamic`, `token` and other formulas are unknown. A missing entry gaps only that row.

**Basis.** A rate is valid for a derived row while the SHA-256 of that entry's canonical `billing` and `input_schema` matches the projection's. A re-pin that leaves the entry unchanged keeps its rate. Older builds decode only exact top-level keys and credit decimals inside rates, so the v2 feed cannot carry the digest. The collector writes `pricing/v2/poyo-basis.json` with `{revision, feedSha256, digests}`: the feed's revision, the SHA-256 of `canonicalJson(decoded feed)` as `local-feed.ts` defines it, and one digest per rate key. The feed and its basis are one unit:

- `publish.sh` publishes both in one tree, or neither.
- `refresh.ts` fetches both, applies the feed's size limit to each and validates the pair before it replaces the cached pair.
- `studio-feeds.ts` embeds the bundled basis beside the bundled v2 feed.
- `loadLocalPricing` and `preferPoyoFeed` select the feed and its basis from the same source, cache or bundled. A cached feed never pairs with the bundled basis.
- `stage-feeds.sh` only stages both files for `freshness.ts`, which checks the pair.

When the selected feed is v1, the pair is mixed, its revision or body digest does not match, or a refresh stopped between the two files, every derived rate is unknown. Older builds ignore the basis file. Verified representatives (`z-image`, `seedream-5.5`, `h3-max`) keep quoting from their reviewed rate keys without it. Fixtures quote a derived row after a refresh, after a restart and from the bundled load.

**Rate kinds.** The collector emits a shipped kind only when the entry fits that kind's decoder exactly. An older build rejects the whole v2 feed when a shipped kind fails to decode, as `per-second-by-resolution` does with a `2K` key. Anything else gets a new kind within the unfamiliar-rate grammar:

- `kind` matches `^[a-z][a-z0-9-]{0,63}$`.
- Records nest at most four levels, counting the rate's own fields as level 1, as `decodeFields` does. Leaves are credit decimals.
- Keys match `poyoRateKey`. The collector normalises others, for example `480*832` to `480x832`, and the lookup applies the same normalisation.
- At most 1,000 rates and a 64 KiB wire limit, so about 173 rates must average under roughly 370 bytes.

ToAPIs derived rows use unknown-price consent. The v2 ToAPIs decoder requires exactly its six rates and two gaps, so adding a model would make older builds discard every refreshed ToAPIs rate. A quote that expires between Review and Queue makes the claim return `stale` with zero POSTs.

### Claims and replay

At claim, the job stores the exact operation key and a recoverable contract in a new `image_job.contract` column. That contract holds the projection revision, the row digest, the family adapter version, the status route, the result envelope with its response-model match rule, and the formats. Video Save limits stay in `save_seconds`, their single source. A claimed job dispatches, recovers and saves from what it stored, even after a re-pin removes its row. Replay resolves a claimed job from storage before it rejects a removed `operationKey`. A NULL contract keeps the shipped adapter paths.

The Review digest binds:

- the exact body
- disclosures and acknowledgements
- the price quote
- the access evidence: snapshot check time and credential revision
- the staged media digests

A change to any of them, to an override or rule hash, or to the D4, Save or Gallery-size wording makes an unclaimed Review stale. A fresh click then returns `stale` with zero POSTs and zero uploads.

**Local files on derived edit rows.** Review also binds the operation key, the row's contract digest and a request template with ordered, typed stage slots, for example `image_urls[0..2]: staged image`. Queue validates the template before any transfer. Once the uploads return their URLs, it fills the slots and validates the full body again before the generation POST. Either failure sends no generation request. A stale consent transfers zero bytes, and an unusable upload receipt (missing, not a URI, or failing the slot's pattern) sends no generation request. Each has its own test.

### Access refusals

A Poyo.ai image 403 whose code is `permission_denied_error` is a per-job permission refusal that keeps the saved key, as video already does. A plain 403 without that code stays an authorization failure. Today `poyo/image.ts` maps both to authorization. Siluet records a confirmed refusal per (credential revision, model), and Review shows it with its date. Queue stays available, and a new credential revision clears the record.

## Save

### Images and still WebP (G1)

Gallery verifies still WebP, lossy and lossless, with the same full sharp decode, warning refusal, timeout and size limits as PNG and JPEG. It keeps the delivered bytes and serves `image/webp`. Before decoding, a RIFF walk checks the file:

- The size field equals the file length less 8, with no trailing bytes.
- Every chunk fits, and odd sizes carry one zero pad byte.
- The chunks are `VP8 ` or `VP8L` alone, or `VP8X` first, then optional `ICCP`, then one image chunk, then at most one `EXIF` and at most one `XMP `, in either order. `ALPH` may appear only directly before a `VP8 ` image chunk, never with `VP8L`. Any other chunk, or a repeat, is refused.
- `VP8X` flags match the chunks present: ICC with `ICCP`, alpha with `ALPH` or `VP8L` alpha, EXIF and XMP with theirs. Its canvas size equals the image chunk's dimensions.

The walk refuses the `VP8X` animation flag, `ANIM` and `ANMF`, and sharp's `pages > 1`. A refusal is held as **unsupported image for Gallery**, as GIF is. A truncated WebP takes the failed-download path (D9). Downloads are named `.webp`. The migration rebuilds `gallery_image` to admit `image/webp` and copies every row and every video constraint unchanged, including the 61 s ceiling.

### Output formats (G3)

Each row offers only its schema's formats that Gallery can save, sent verbatim (`jpg` stays `jpg`). Review shows the expected type. The preselected format is the effective default when Gallery saves it. Where the effective default is unresolved, the composer preselects and sends an offered format, as for any [unresolved default](#deriving-and-validating-rows). `gif` is never offered. A model without the option may return any type. Save records the actual verified type and holds the rest.

At `747e5d7`, 35 in-scope entries have `output_format`. D5 says fifteen offer WebP, but a recount on the same basis finds sixteen: `flux-3-klein` and `-edit`, `gpt-image-2.5-flare` and `-sunburst`, `gpt-image-2.6-flare` and `-sunburst`, `kling-o1-image-edit`, `kling-o3-image` and `-edit`, `mai-image-2.7` and `-flash`, `nano-banana-2-official` and `-edit`, `nano-banana-2-new` and `-edit`, and `qwen-image-2.1`. `gpt-image-2.6-flare` and `-sunburst` also offer GIF. `seedream-5.0-flash*` and `flux-kontext-*` have no default, so their composer preselects a format.

### Gallery size limits

The owner asked on 2026-11-26 for Gallery to support every size the providers offer (D5, D6). Today Gallery saves up to 16,000,000 pixels and 16,384 px per edge. D6 allows 1,920 px per edge, 2,073,600 px, 64 MiB and 60 fps.

- Until G13 and G14 land, an option value over these limits has no covered path. Each such value blocks the tag.
- **G13** raises the image limits to the largest documented output, for example 4K tiers (4096×4096), explicit `WxH` and ToAPIs `minimax-h3-image`'s custom sizes ("total pixels in the range 655360-20000000"). It raises, with peak memory and time measured in CI, every bound in the path: the Gallery pixel and edge limits, `verificationPixels` (20 MP, `verify-image.ts`), `encodedLimit` (32 MiB, `gallery/download.ts`), the transfer deadline, `mediaLimits.image` (32 MiB) and the per-tab read cap (`maxBytes` in `private-media.ts`, 192 MiB today).
- **G14** raises D6's dimension caps, frame-rate bound, the 64 MiB download and the 4 MiB `moov` budget to each operation's documented maximum, including 1080p, 2K and 4K. It also raises the browser-key delivery budget: `mediaLimits.video` (64 MiB per video) and the same per-tab read cap. G14's PR amends D1's 64 MiB cost line with the measured bound. Larger sizes within `avc1`/`mp4a` SDR are verified from fixtures. A new codec, profile, bit depth or HDR needs a suitable real sample, which takes an owner-approved live call (D6, D11).
- Each raised image and video bound has a built-app journey that saves an output at that bound, reopens it offline and checks that the downloaded original's bytes match the saved ones. The journey reads the configured per-tab read cap from the build and checks the measured reads against it, rather than a hardcoded 192 MiB.
- An undocumented maximum keeps today's limit. That option's state is unknown, with [question 11](#open-questions). An image row may still be offered with the Review statement below, but a video row stays Review-only.
- When the request cannot bound the output, as with `auto` or a reference-following edit, Review states the limit: "Gallery saves images up to N megapixels. A completed billable image over that stays with the provider." The statement is bound into the digest.

### Video Save limits

Every shipped limit keeps its value and basis: Seedance 30 s (`provider`, and `upstream` for edit) and H3 Max 15 s (`provider`). A derived row needs one of two bounds:

- an output bound documented for its exact operation: the integer maximum of `duration` in that operation's schema branch, or the page's stated maximum
- the approved upstream fallback for a source-following operation: an uncontradicted cap of 60 s or less, with basis `upstream`

Otherwise the row is Review-only.

- `0`, `-1` and other unbounded durations are never offered as a choice. A source-following edit may send a fixed wire sentinel when its operation has an independently evidenced cap, the approved upstream Save limit. Shipped Seedance edit sends `-1` this way. ToAPIs `seedance-2-5-flash` video-edit is the derived fixture.
- Resolution values match case-insensitively and are sent verbatim.
- A row without a resolution field needs a documented frame bound, such as `wan2.5-text-to-video`'s pixel ratios (`1920*1080`).
- `auto` and `adaptive`, for aspect or resolution, mean the output follows the input or the model's choice. They are offered only when a documented frame bound covers every outcome.
- Nominal frames must fit D6's limits as raised by G14.

## Shared ToAPIs inventory snapshot (G9)

One snapshot is kept per (provider, origin, scope `image` or `video`, credential revision). It holds `checked_at`, the outcome and the exact IDs that `GET /v1/models?type=<scope>` returned, and it is replaced atomically. ToAPIs documents the list as "models available to the current API key and user group".

- A model is **listed**, **absent** from a fresh snapshot, or **unknown**. Unknown covers no snapshot, a failed check, another credential revision, or a snapshot older than 24 hours.
- Only *listed* allows Queue.
- A failed check is recorded and blocks Queue until a later check succeeds.
- The Queue claim re-checks freshness and credential revision in its transaction.
- Each check carries the credential revision and a generation number. A late response is discarded.
- **Check again** is rate-limited to three checks a minute per scope. When Review opens on a stale snapshot with a saved key and a network, Siluet runs one automatic check, which is non-billable, within that limit. Without either, the check is skipped and the model stays unknown.
- A listing is not evidence of entitlement, D4 compatibility or price.

The migration adds the snapshot table. **Pre-snapshot exception:** the shipped ToAPIs operations (Seedream 5.5 image, Seedance 2.5 video) keep their `model_access` record and the Seedream flag in the credential's authenticated data until any snapshot exists for that (origin, scope, credential revision). The exception never authorizes a derived row. Once a snapshot exists, it is the only evidence: a failed, stale or absent result never revives the old record. Old records cannot become snapshots, because a single-model record would mark every other model absent.

## Coverage and the tag

`bun run catalog:coverage` expands every ledger key and option and gives each exactly one state:

- **verified**
- **contract-covered**, including rows on any queueing D4 state
- **documented and pending**, with the missing class, construct or bound
- **provider unsupported**, with evidence
- **unknown**: provider evidence is missing or contradictory, the source has been checked and an open question is recorded

**Option obligations** come from the full documented contract, including fields Siluet does not send. An obligation is one creator-selectable option of one exact operation. One Queue-eligible path on that row satisfies it when the path offers the option's whole documented domain: every enum value, the full numeric range, or free text within the documented length. Values Siluet fixes are not obligations: the D4 boolean at `false`, a pinned `n: 1` and fixed wire sentinels such as Seedance edit's `-1`. Combinations follow the reviewed rules. A value over Gallery's limits is covered only once G13 or G14 covers it. Documented values beyond a Siluet envelope remain obligations until the slice that raises the envelope lands, such as `h3-max` prompts above 4,000 bytes until G7. Free text on a row whose limit is undocumented is unknown with [question 10](#open-questions). Values that the two Poyo.ai sources dispute are unknown with [question 8](#open-questions). Tests prove that D4's fixed value does not block coverage and that removing a genuine creator option from the composer leaves a blocker.

The report prints tag-counting coverage separately. It also prints the **tag-blocking count**:

- pending pairs and options
- operations or options without a verified or contract-covered path
- unsupported pairs without evidence
- unknown pairs or options without a question
- documented values that a Siluet envelope excludes, until the envelope is raised

The tag needs that count at zero, unless the owner approves a scope change for each remainder (D11). The [inventory](catalog-engine-inventory.md) is its first output. From G2a, CI regenerates it and fails on any difference.

The arithmetic: at `747e5d7`, the catalog alone splits the 162 in-scope entries into 31 declared, 98 open and 33 closed. With the OpenAPI REST column, the four open `poyo-ai/*` tools are closed-absent, giving 31 declared, 94 open-absent and 37 closed-absent. At `ec73207` the catalog split is 31, 98 and 44, and with the REST column 31, 94 and 48. Counted by documented ledger ID instead, the split is 31, 89 and 48 of 168 at `ec73207` (31, 89 and 39 of 159 at `747e5d7`; the [inventory](catalog-engine-inventory.md#d4-states-after-the-ledger-migration) reconciles the two). All three queueing states count. At `ec73207` the ledger expands to 663 documented keys (333 Poyo.ai, 330 ToAPIs; Midjourney `imagine` counts once despite its route alias; 647 at `747e5d7`), and 11 are verified. Engine slices cover 506 and Phase 3 covers 153 (496 and 147 at `747e5d7`), so 4 wait on evidence. 26 discovery-only IDs add no keys until their contracts are found. A key in an engine slice still counts as tag-blocking while its schema, class, Save bound or a D4 contradiction keeps it pending.

## Failure, unknown and stale cases

- **Schema outside the validator, an unqualified required input or no valid request.** The row is pending and Review names the reason. The adapter is never called.
- **Upstream drift.** The drift job fails, and app behaviour does not change until a re-pin. Removed rows stop queuing, and their claimed jobs finish from the stored contract.
- **Price basis missing, mismatched or half-refreshed.** The derived rate is unknown, with unknown-price consent.
- **Inventory check fails, goes stale, is skipped or answers late.** The model is unknown and Queue is blocked. A late answer is discarded.
- **Lost ToAPIs image acknowledgement.** The job is uncertain and is never resubmitted.
- **Provider rejects the filtering field.** The rejection is confirmed after one POST, with no resubmission. Jobs says the provider refused the request.
- **Output Gallery cannot save** (type, animation, size, Save limit). The job completes and is held, with Retry download where D9 allows it. A truncated download is a failed download.
- **Poyo.ai 403 `permission_denied_error`.** That job is refused, and the key stays.

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
- **Never:** fetch a catalog or docs page at runtime; drop a field the provider accepts; resubmit after a rejection or a lost acknowledgement; widen a row beyond its evidence.

## Acceptance, offline with fixtures

Run `bun run --bun test`, `bun run --bun build` and `bun run --bun smoke`.

1. **Derivation.** It reproduces the committed rows byte for byte. Both projections and `poyo-rows.json` are canonical compact JSON under 500 KB, each SHA-256 matches its record, and a re-pin fixture verifies the upstream digests and projections. The OpenAPI projection holds only in-scope IDs' schemas and the full manifest, and a fixture spec with a remote `$ref` fails it. The client bundle stays within its recorded budget.
2. **Validator.** Each supported construct, allowlisted pattern and reviewed rule has passing and negative fixtures. The `flux-3-klein` size rule passes a listed ratio and refuses an unlisted ratio and explicit dimensions with the wrong tier. The gpt-image, MAI, Ideogram and Seedream rules each pass a listed value and refuse an unlisted one and explicit dimensions failing each documented check, and the Seedream rule never offers a custom size or `seedream-4.5`'s `4K` before G13. The Ideogram rules cover `ideogram-v4.5-edit`, `ideogram-v4.6` and `ideogram-v4.6-edit`: they refuse `quality: very_low` above 4,194,304 px on v4.6, refuse an explicit size with a mask or `edit_precision: high`, refuse a fourth reference with a mask, refuse a `data:image` URI without `;base64,` on v4.6-edit, and send `edit_precision: "regular"` with every explicit size. Every pattern outside the allowlist without a rule leaves its option uncovered. A body valid for the catalog but not the closed OpenAPI input fails: `gpt-image-2.6-fixed` with `resolution`, and `poyo-ai/image-translator` with each of its three catalog-only fields, while the same bodies without those fields pass. A disputed value fails and a shared one passes (`seedream-4.5` `n`), and coverage reports `n` 2–6 as Phase 3 and 7–15 as unknown. A prose-only option without a typing rule is never sent. The ToAPIs `minimax-h3-image` rule passes a ratio body with `resolution` and an explicit-`size` body with neither `resolution` nor `aspect_ratio`, and refuses explicit `size` with `resolution`. Unsupported constructs on required and optional inputs, a stale rule hash and a row with no valid minimal request each yield their stated state.
3. **Drift.** A fixture upstream with one model added, one removed, one enum changed and one billing changed makes `catalog:drift` fail and list all four. A changed descriptor, OpenAPI spec, REST or model-list digest fails the same way, and an unchanged upstream passes.
4. **Queue conditions.** Failing any one condition alone blocks Queue with its message, zero POSTs and zero uploads. Eleven local files on Poyo.ai `minimax-h3-image` show the upload-limit message and transfer nothing.
5. **D4.** Every cell of the table and the refused state have a fixture through the guard in `submission.ts`, `services/queue/video.ts`, `services/file-edit/queue.ts` and both `ImageReview.svelte` call sites, including both Gemini Omni Flash rows. Each shipped operation keeps its behaviour through the changed guard:
   - Closed-absent makes zero POSTs without the acknowledgement. With it, the body omits the field.
   - Open-absent and declared send `false`. Open-absent needs its disclosure, or the fixed disclosure for that cell, and rows without an OpenAPI spec show the unreviewed-page sentence. Only a declared row's route-evidence note says the contract "declares" the field.
   - A closed REST input that also says filtering is fixed takes the closed column, never *fixed*. ToAPIs `minimax-h3-image` is open-absent, and a page with a conditional fallback shows the separate fallback note.
   - `moderation` on `gpt-image-2.6-flare` and `-sunburst` is offered as an ordinary option.
   - The acknowledgement names the closing source: API schema, catalog schema, or both.
   - Contradiction, refused and `unknown` block.
   - Changed wording makes the Review stale.
   - A rejection fixture makes one POST, records a confirmed rejection and sends nothing more.
   - The migrated ledger has no `conflict` outside contradiction and no `catalogD4` of `declared` or `unknown`, and its counts match the inventory query.
6. **Payload and recovery.**
   - The serialized body validates against both schemas with no defaults added. Review, the price and the Save bound use effective defaults. A default listed by one source and absent from the other is unknown (`gpt-image-2.6-fixed` tier). A creator-selectable field with an unresolved default that the merged schema accepts is preselected and sent explicitly. An image row then saves within the stated Gallery limit, and a video row whose Save bound depends on it stays Review-only.
   - A completed result with more than one image is held, and nothing is saved.
   - `n: 1` is sent where a count field accepts 1. A row without one queues only with evidence of one output (Seedream 5.5), and is pending otherwise.
   - Over-length prompts and free-text options fail at a stated limit, in code points and, on the video path, at 4L bytes, and at Siluet's envelope where schema and page are silent. `h3-max` passes 50,000 four-byte code points after G7 and refuses 50,001. Coverage reports free text on rows whose schema and page state no limit as unknown with question 10, and `h3-max` above 4,000 bytes as tag-blocking until G7.
   - A ToAPIs image job sends no correlation and sets no `business_id`. A lost acknowledgement leaves it uncertain with no second POST.
   - URI fields are redacted in logs.
7. **Pricing.**
   - An exact match quotes, `1080P` matches `1080p`, and any other option is unknown.
   - An unchanged-digest re-pin keeps the rate. A derived row quotes after a refresh, after a restart and from the bundled load.
   - A missing basis, a basis for another revision or body, a selected v1 feed, a cached feed beside the bundled basis and an interrupted refresh each make derived rates unknown, while verified representatives still quote.
   - An older build's decoder fed a `2K` tier and a three-level price table keeps the feed and treats both as unquotable. `480*832` is published and looked up as `480x832`.
   - A quote that expires between Review and Queue goes stale.
8. **Claims.** A claimed job whose row a re-pin removed still replays, recovers and saves. A job with a NULL contract takes the shipped path. A stale consent transfers zero bytes. An unusable upload receipt sends no generation request.
9. **WebP and formats.**
   - Offered values are sent verbatim, and `gif` is never offered.
   - Lossy and lossless still WebP save, reopen offline, serve `image/webp` and download as `.webp`.
   - Animated, padded-wrong, trailing-byte, unknown-chunk, repeated-`EXIF`, `ALPH`-with-`VP8L`, wrong-flag, wrong-canvas and multi-page WebP and GIF are held. `EXIF` and `XMP ` after the image save in either order. Truncated WebP retries as a failed download.
   - An upgrade keeps every Gallery row and video constraint.
10. **Sizes and video.**
    - Before G13 and G14, over-limit values have no covered path. After, they are offered within the measured budgets, and each raised constant is tested at its bound.
    - Each raised image and video bound has a built-app journey that saves, reopens offline and checks the downloaded original's bytes, within the configured and measured per-tab read cap.
    - Video rows take their limit per operation. Unbounded durations are never a choice, and `auto` without a frame bound is never offered. The `seedance-2-5-flash` edit sends its fixed sentinel under the upstream limit.
    - Resolution matching is case-insensitive.
11. **Inventory.** Fixtures cover listed, absent, failed, stale, skipped (no key, no network), revision change, a late response and two concurrent checks. Only a fresh *listed* entry queues. The claim re-reads it, and replacement is atomic. The pre-snapshot exception queues a shipped operation, never a derived row, and does not revive after a failed, stale or absent snapshot.
12. **Review.** It names the verified model, schema revision and date, and "not individually tested". A `permission_denied_error` 403 refuses one job and keeps the key. A plain 403 stays an authorization failure.
13. **Qualification.** Each new class passes the seven family fixtures on its named model and one built-app journey to verified Save and offline reopen.
14. **Coverage.** `catalog:coverage` gives every expanded key and option exactly one state, and a route alias adds no key. Its tag-blocking count matches the ledger. A genuine creator option removed from the composer still blocks, while D4's fixed `false`, a pinned `n: 1` and a fixed sentinel never do. The inventory regenerates unchanged.

## Slice plan

Slices merge in table order, and each is independently mergeable. G2c lands before G4. Later re-pins land only through `catalog:drift` and a reviewed [data-and-rules PR](#deriving-and-validating-rows), and G12 freezes the D2 baseline. The numbers are the round-1 names. G9 can run alongside G3–G8b, and G13 and G14 alongside the slices before them. Every slice lands before the tag. Each qualifying slice includes a built-app journey from Queue to Save on a derived row.

| Slice | Creator-visible outcome | Verification |
| --- | --- | --- |
| G1 Still WebP Save | A WebP result saves, reopens offline and downloads as `.webp`; animated WebP and GIF are held. | Check 9; migration upgrade test. |
| G2a Derivation and coverage | Contributors get derived rows from the catalog and OpenAPI projections, the validator, the migrated ledger D4 states with the guard at every call site, including both in `ImageReview.svelte`, tested offline against the shipped operations, and `catalog:coverage` with its tag-blocking count and no alias double counting, all offline. | Checks 1, 2, 5 (ledger and guard) and 14. |
| G2b Picker | The picker lists every derived row as Review-only with its reason. | Picker journey. |
| G2c Re-pin | Data and rules, before G4: both projections, ledger and price feed move to `ec73207` together, with the evidence, coverage and tag-blocking diffs; stale rules are re-bound or retired; the `ideogram-v4.6` patterns are recorded as data; and the D2 baseline is re-dated. | Checks 1 and 14. |
| G2d Drift job | The weekly online drift check runs (CI change, owner approves). | Check 3. |
| G3 Per-model formats | Image Review offers each model's own formats and shows the expected type; Seedream moves onto the same path. | Check 9. |
| G4 Poyo.ai text-to-image | Declared and open-absent image rows queue, with the disclosure where needed, estimates or unknown-price consent, and the access note; Seedream 4.5 and 5.0 Lite offer their listed sizes, apart from Seedream 4.5's `4K`, which waits for G13; `qwen-image-2.1` becomes verified for booleans and integers; a permission 403 keeps the key. | Checks 4–8, 12 and 13; migration test. |
| G5 Poyo.ai image edits | The same rows edit with 1–10 ordered URLs or local JPEG/PNG. More than 10 references wait for G6b. `bria-rmbg-3.0` (`image-background-removal`, added at `ec73207`: one image in, a transparent PNG at the input's size out) is placed here; it is closed-absent, so it queues only after G6's acknowledgement, and because its output follows its input, its Save bound is the stated Gallery limit until G13. | Checks 8 and 13. |
| G6 Closed-absent image rows | Closed-schema image rows queue after the acknowledgement (gpt-image-2.5/2.6, Ideogram, Kling image, MAI, `minimax-h3-image` and others), including `gpt-image-2.6-flare` and `-sunburst` with `moderation`; the gpt-image, MAI, Ideogram (v4.5-edit, v4.6 and v4.6-edit) and Poyo.ai `minimax-h3-image` size rules land here. | Checks 2 and 5. |
| G6b More than 10 Poyo.ai references | Poyo.ai `minimax-h3-image` edits with 11–16 ordered references, at most 10 of them local, Review promises their order, and the price is unknown; with more than 10 local files Review shows the upload-limit message and offers no Queue. | Checks 4 and 13 with 11 and 16 references; built-app journey to verified Save. |
| G13 Gallery image limits | 4K tiers and large explicit sizes, up to `minimax-h3-image`'s 20 MP, save within measured decode, download, transfer and per-tab read budgets. | Check 10; built-app save, offline reopen and original-bytes download at each raised bound. |
| G7 Poyo.ai text-to-video | Poyo.ai video rows queue with data Save limits, including closed-absent rows after the acknowledgement; `wan3.0-text-to-video` and `wan2.5-text-to-video` become verified for booleans and free text; `h3-max` prompts rise to 50,000 characters. | Checks 5, 10 and 13. |
| G8 Poyo.ai frames | First and first-and-last frames qualify on H3 Max, then derived rows follow with reviewed role notes, including `start_image_url`/`end_image_url`. | Check 13. |
| G8b Poyo.ai image references | `reference_image_urls` qualifies on H3 Max, then derived reference-to-video rows follow. | Check 13. |
| G14 Gallery video limits | 1080p, 2K and 4K clips save and reopen offline in the built app within measured budgets, including the per-tab read limit; D1's 64 MiB cost line is amended with the measured bound; new structures only after an approved real sample. | Check 10; built-app save, offline reopen and original-bytes download at each raised bound. |
| G9 Inventory snapshot | Settings and Review show listed, absent or unknown per exact ToAPIs model, with Check again. | Check 11; migration test. |
| G10a ToAPIs text-to-image | Admitted ToAPIs image rows queue with disclosure and unknown-price consent, without correlation; pages that neither name nor link the status route stay Review-only. | Checks 4–6 and 13. |
| G10b ToAPIs image edits | Admitted rows edit with references; `minimax-h3-image` qualifies up to 16 with `n: 1`, if it passes the other admission checks. | Checks 8 and 13. |
| G11a ToAPIs text-to-video | The adapter serves every admitted exact ID; text-to-video rows queue. | Checks 5, 10 and 13. |
| G11b ToAPIs frames | First and first-and-last frame rows queue. | Check 13. |
| G11c ToAPIs reference generation | Image-reference, frame-and-image-reference and one-reference-video rows queue, each qualified on its first admitted row, apart from edit. | Check 13. |
| G11d ToAPIs source edit | Admitted non-Seedance video-edit rows queue with an upstream or documented bound. | Checks 10 and 13. |
| G12 Engine reconciliation | Every engine-scope pair and option has its final state against the frozen D2 baseline (a later re-pin before the tag reopens this recount), and the engine's share of the tag-blocking count is zero or each remainder has an owner-approved scope change. | Check 14; recount recorded in the ledger. |

**Bespoke work outside the engine, for Phase 3.** Each needs a new class or contract on its family representative, then joins as data. The [inventory](catalog-engine-inventory.md) counts each:

- layer decomposition: Poyo.ai `seedream-5.5-layerize`, ToAPIs `layer_decomposition`
- audio and avatars: `reference_audio_urls`, `audio_url`, driving-audio and public-avatar operations (HeyGen, Kling Avatar, OmniHuman, `sync-lipsync-3`)
- video and mixed references: multimodal, image-and-video, subject-and-motion and subject-and-media references
- subjects and non-URL characters (`subjects-to-video`, `sora-2-vvip` personas)
- positioned, last-frame-only and multi keyframes; draft and draft-to-final chains; multi-shot
- source-video work on Poyo.ai: edit, video-to-video, motion, character replacement, upscaling, background removal, translation (Review-only at 360 s)
- video extension, the ToAPIs `/v1/videos` envelope and remix routes, and Midjourney actions
- masks, markup and localized edits; multi-output and image sets; GIF and SVG output
- music-task prerequisites (`generate-music-cover`, `create-music-video`)
- local MP4, WAV and other formats (Uploads 1 and 2)

Long, webpage and e-commerce images and image translation stay in the engine. They join G4, G5 or G10 once G13 covers a documented output bound, and translation once a reviewed rule types its language strings (question 6). The translator's three catalog-only options follow question 7.

## Open questions

For the owner or council. The former question 1 is settled: G14 amends D1's 64 MiB cost line with the measured bound.

2. **ToAPIs image pages that neither name nor link the status route.** These rows are Review-only, and their number is unknown until G10a reads every page. *Recommendation:* keep the rule, and ask ToAPIs to link the generic route.
3. **Number options.** Only `kling-1.6/pro` and `/standard` (`cfg_scale`) and the Phase 3 upscaler use `number`. Neither the Kling 1.6 page nor its OpenAPI spec documents an output frame size, so neither row has a Save bound, and the class has no admitted representative. *Recommendation:* name `kling-1.6/pro` the number representative once Poyo.ai documents a frame size, and keep both rows unknown until then. Approve a scope change for them only if none is documented before G12.
4. **More than 10 references.** Settled in round 4: G6b qualifies the class on Poyo.ai `minimax-h3-image`, and G10b on ToAPIs `minimax-h3-image`.
5. **Explicit D4 refusals.** Settled in round 4: none is known, and ToAPIs `minimax-h3-image` is open-absent. Any explicit refusal found later needs a D4 decision before it counts.
6. **Free text and language strings on Poyo.ai images.** Only `qwen-image-3` and `qwen-image-3-pro` carry free text (`negative_prompt`) on Poyo.ai images, and none of their sources states an output count. Both rows are pending, and the class has no representative. `poyo-ai/image-translator`'s `source_language` and `target_language` are untyped strings with no documented domain, so they have no covered path without a reviewed rule. *Recommendation:* keep these rows unknown with this question, ask Poyo.ai to document the output count and the language codes, type the languages by a reviewed rule once documented, and decide at G12.
7. **Fields one source lists while the other is closed.** `gpt-image-2.6-fixed` (`resolution`), `poyo-ai/image-translator` (`protect_text`, `synthesis_on_image`, `translate_on_image`) and the Phase 3 `poyo-ai/video-translator` (`wy_need_text`, `voice_role_id`, `remove_bg_audio`) list fields in the catalog that their closed OpenAPI inputs do not. `kling-4.0` listed `dynamic_range` in its OpenAPI input while its `747e5d7` entry was closed without it; the `ec73207` entry lists it, so it left this question at the re-pin. *Recommendation:* never offer them, keep each option unknown, report the difference to Poyo.ai, and approve a scope change at G12 for any that remain.
8. **Disputed domains.** The catalog and the OpenAPI input list some fields with different limits, such as `seedream-4.5` `n` (1–15 against 1–6) and `gpt-image-2.6-flare` `output_format` (`gif` only in the catalog). The [inventory](catalog-engine-inventory.md#disputed-domains) lists them. *Recommendation:* offer the shared domain, keep the disputed values unknown, report them to Poyo.ai, and approve a scope change at G12 for any that remain.
9. **Edit output count for gpt-image-2.5 and 2.6 Fixed, Flare and Sunburst.** Their inputs state one output only for generation, so their edit rows stay pending. *Recommendation:* keep them unknown with this question, ask Poyo.ai to state the edit output count, and decide at G12.
10. **Prompt limit not documented.** Some rows' schemas and pages state no limit for `prompt` or a free-text option. The [inventory](catalog-engine-inventory.md#prompt-limits) lists them. Queue enforces Siluet's envelope, 4,000 UTF-8 bytes on video and 5,000 code points on images, and coverage reports that free text as unknown. *Recommendation:* ask each provider to state the limit, raise the composer to it once stated, and approve a scope change at G12 for any that remain.
11. **Undocumented domains and maximums.** Some options have no documented domain or maximum: prose-only strings marked "omitted until documented" in the [inventory](catalog-engine-inventory.md#prose-only-domains), Seedream 4.5 and 5.0 Lite custom sizes, and any option whose maximum output Gallery cannot bound. Each is omitted or keeps today's Gallery limit, and its state is unknown. *Recommendation:* ask the provider to document each, type it by a reviewed rule once documented, and approve a scope change at G12 for any that remain.

## Unverified

- Which ToAPIs pages name or link the image status route.
- Whether undocumented filtering fields have any effect on either provider, including the 89 open-absent IDs whose OpenAPI inputs are open without the field.
- The REST state of the eight IDs added at `ec73207` that have no OpenAPI spec.
- Which branch of a multi-model OpenAPI spec applies to each model. The throwaway projection takes their union, so it may miss a catalog-only field or report a disputed domain that one branch does not have. G2a resolves each branch.
- Whether order matters for ToAPIs `minimax-h3-image` references.
- Whether the model pages state prompt limits for the rows whose schemas are silent. The round-6 survey read only schemas and their descriptions.
- Custom-size ranges for Seedream 4.5 and 5.0 Lite.
- Actual output dimensions per tier and ratio, delivered types when a format is requested, and the largest outputs and decode costs G13 and G14 must measure.
- Per-key Poyo.ai entitlement.
- Whether ToAPIs' Markdown pages are stable enough to hash without false drift.

## Sources

- PoYo capability catalog at [`747e5d7`](https://github.com/PoyoAPI/poyo-devtools/blob/747e5d75319585d66396a3c05bd1b97d9390ce74/artifacts/capability-catalog.json) (committed 2026-11-19) and [`ec73207`](https://github.com/PoyoAPI/poyo-devtools/blob/ec7320720913a55f955e1bf6a651e9c38bd356c5/artifacts/capability-catalog.json) (2026-11-26, the upstream head when G2c re-pinned on 2026-11-27), compared with `c89a6a4`. Fetched 2026-11-26.
- [PoYo docs index](https://docs.poyo.ai/llms.txt) and REST pages for Nano Banana 2, 2 New, 2 Lite, Kling 1.6, Kling 3.0, Kling 4.0, Seedance 2.5, Flux 3 Max, Ideogram v4.6, Gemini Omni 1.1 and 1.2 Flash, and the image translator, video background removal, video translator and video upscaler tools, accessed 2026-11-26. Qwen Image 3 and Nano Banana 2 Lite pages re-read 2026-11-26.
- The 175 PoYo OpenAPI specs that the docs index lists under "OpenAPI Specs", fetched 2026-11-26. The [inventory](catalog-engine-inventory.md#poyoai-openapi-specs) holds their digests.
- ToAPIs [model list](https://docs.toapis.com/docs/en/api-reference/chat/list-models), [image status](https://docs.toapis.com/docs/en/api-reference/tasks/image-status), [GPT Image 2](https://docs.toapis.com/docs/en/api-reference/images/gpt-image-2/generation), [Seedream 5.5](https://docs.toapis.com/docs/en/api-reference/images/seedream-5.5/generation), [MiniMax H3 Image](https://docs.toapis.com/docs/en/api-reference/images/minimax-h3-image/generation) (Markdown SHA-256 `bbb2b08…`) and [Seedance 2.5](https://docs.toapis.com/docs/en/api-reference/videos/seedance-2-5/generation), accessed 2026-11-26. The [public catalog](https://docs.toapis.com/docs/en/api-reference/models) snapshot is dated 2026-11-10.
