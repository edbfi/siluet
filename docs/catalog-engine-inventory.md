# Catalog engine · remaining-work inventory

Generated on 2026-11-26 from the [ledger](media-catalog.v1.json) (observed 2026-11-22) by expanding each documented row into its `(provider, ID, route, operation)` keys. It is a snapshot for [the catalog engine spec](SPEC-catalog-engine.md): from G2a, `bun run catalog:coverage` regenerates this inventory, with option gaps per derived row, and CI fails on any difference. **G*n*** is an engine slice, **P3** is bespoke Phase 3 work, and **Q** is an evidence question. Every item lands before the v0.1.0 tag ([D11](decisions.md#d11--v010-waits-for-full-d2-coverage)).

Expanded keys: 647, of which Poyo.ai 317 (5 verified) and ToAPIs 330 (6 verified). Engine slices hold 496, Phase 3 147 and evidence questions 4. A route alias adds no key: Midjourney `imagine` counts once, on its primary route. A slice listed here may still leave a key pending when its schema, input class, Save bound or D4 table blocks it; `catalog:coverage` names that reason per key.

## Documented operations

| Assigned to | Provider | Operation | Keys | Verified |
| --- | --- | --- | ---: | ---: |
| G4 | Poyo.ai | `text-to-image` | 47 | 2 |
| G4 after G13 · Q: documented output bound | Poyo.ai | `text-to-long-image` | 1 |  |
| G5 | Poyo.ai | `reference-image-edit` | 49 | 2 |
| G5 · Q: target-language option | Poyo.ai | `image-translation` | 1 |  |
| G5 after G13 · Q: documented output bound | Poyo.ai | `reference-guided-long-image-generation` | 1 |  |
| G7 | Poyo.ai | `text-to-video` | 50 | 1 |
| G8 | Poyo.ai | `first-frame-to-video` | 52 |  |
| G8 | Poyo.ai | `first-and-last-frame-to-video` | 34 |  |
| G8b | Poyo.ai | `reference-to-video` | 23 |  |
| G8b | Poyo.ai | `image-reference-to-video` | 2 |  |
| G10a | ToAPIs | `text-to-image` | 41 | 1 |
| G10a after G13 · Q: documented output bound | ToAPIs | `text-to-webpage-image` | 1 |  |
| G10b | ToAPIs | `reference-image-edit` | 41 | 1 |
| G10b after G13 · Q: documented output bound | ToAPIs | `reference-guided-webpage-image` | 1 |  |
| G10b after G13 · Q: documented output bound | ToAPIs | `reference-guided-ecommerce-image` | 1 |  |
| G11a | ToAPIs | `text-to-video` | 43 | 1 |
| G11b | ToAPIs | `first-frame-to-video` | 43 | 1 |
| G11b | ToAPIs | `first-and-last-frame-to-video` | 26 | 1 |
| G11b | ToAPIs | `image-to-video` | 1 |  |
| G11c | ToAPIs | `image-reference-to-video` | 21 |  |
| G11c | ToAPIs | `video-reference-to-video` | 6 |  |
| G11c | ToAPIs | `frame-and-image-reference-to-video` | 2 |  |
| G11d | ToAPIs | `video-edit` | 9 | 1 |
| Q · file and webpage references (accepted types, who fetches) | ToAPIs | `file-reference-to-video` | 2 |  |
| Q · file and webpage references (accepted types, who fetches) | ToAPIs | `webpage-reference-to-video` | 2 |  |
| P3 · audio and avatar inputs | Poyo.ai | `image-and-driving-audio-to-avatar-video` | 5 |  |
| P3 · audio and avatar inputs | Poyo.ai | `character-video-and-driving-audio-to-avatar-video` | 2 |  |
| P3 · audio and avatar inputs | Poyo.ai | `public-avatar-and-driving-audio-to-video` | 2 |  |
| P3 · audio and avatar inputs | Poyo.ai | `public-avatar-and-text-to-video` | 2 |  |
| P3 · draft and draft-to-final chain | ToAPIs | `draft-video-generation` | 1 |  |
| P3 · draft and draft-to-final chain | ToAPIs | `draft-to-final-video` | 1 |  |
| P3 · GIF and SVG output | Poyo.ai | `text-to-gif` | 2 |  |
| P3 · GIF and SVG output | Poyo.ai | `image-to-svg` | 1 |  |
| P3 · GIF and SVG output | Poyo.ai | `text-to-svg` | 1 |  |
| P3 · GIF and SVG output | Poyo.ai | `reference-guided-text-to-svg` | 1 |  |
| P3 · GIF and SVG output | ToAPIs | `text-to-gif` | 4 |  |
| P3 · GIF and SVG output | ToAPIs | `image-to-gif` | 4 |  |
| P3 · GIF and SVG output | ToAPIs | `text-to-svg` | 4 |  |
| P3 · layer decomposition | Poyo.ai | `image-layer-decomposition` | 1 |  |
| P3 · layer decomposition | ToAPIs | `image-layer-decomposition` | 2 |  |
| P3 · mask, markup and localized edits | Poyo.ai | `mask-image-edit` | 9 |  |
| P3 · mask, markup and localized edits | Poyo.ai | `localized-mask-image-edit` | 1 |  |
| P3 · mask, markup and localized edits | ToAPIs | `mask-image-edit` | 4 |  |
| P3 · mask, markup and localized edits | ToAPIs | `markup-guided-image-edit` | 2 |  |
| P3 · Midjourney actions | ToAPIs | `imagine` | 1 |  |
| P3 · Midjourney actions | ToAPIs | `blend` | 1 |  |
| P3 · Midjourney actions | ToAPIs | `edits` | 1 |  |
| P3 · Midjourney actions | ToAPIs | `upscale` | 1 |  |
| P3 · Midjourney actions | ToAPIs | `variation` | 1 |  |
| P3 · Midjourney actions | ToAPIs | `high-variation` | 1 |  |
| P3 · Midjourney actions | ToAPIs | `low-variation` | 1 |  |
| P3 · Midjourney actions | ToAPIs | `reroll` | 1 |  |
| P3 · Midjourney actions | ToAPIs | `zoom` | 1 |  |
| P3 · Midjourney actions | ToAPIs | `pan` | 1 |  |
| P3 · Midjourney actions | ToAPIs | `mask-inpainting` | 1 |  |
| P3 · Midjourney actions | ToAPIs | `remix-strong` | 1 |  |
| P3 · Midjourney actions | ToAPIs | `remix-subtle` | 1 |  |
| P3 · Midjourney actions | ToAPIs | `image-to-video` | 1 |  |
| P3 · Midjourney actions | ToAPIs | `parent-task-image-to-video` | 1 |  |
| P3 · multi-output and image sets | Poyo.ai | `sequential-image-set` | 1 |  |
| P3 · multi-output and image sets | ToAPIs | `sequential-image-set` | 4 |  |
| P3 · multi-shot | Poyo.ai | `multi-shot-video-generation` | 9 |  |
| P3 · music and parent-task prerequisites | Poyo.ai | `music-task-to-cover-image` | 1 |  |
| P3 · music and parent-task prerequisites | Poyo.ai | `music-track-to-video` | 1 |  |
| P3 · positioned, last-frame and multi keyframes | Poyo.ai | `positioned-keyframes-to-video` | 2 |  |
| P3 · positioned, last-frame and multi keyframes | Poyo.ai | `last-frame-to-video` | 1 |  |
| P3 · positioned, last-frame and multi keyframes | ToAPIs | `keyframes-to-video` | 1 |  |
| P3 · source-video operations on Poyo.ai | Poyo.ai | `video-edit` | 6 |  |
| P3 · source-video operations on Poyo.ai | Poyo.ai | `image-and-motion-video-to-video` | 3 |  |
| P3 · source-video operations on Poyo.ai | Poyo.ai | `video-to-video` | 1 |  |
| P3 · source-video operations on Poyo.ai | Poyo.ai | `video-background-removal` | 1 |  |
| P3 · source-video operations on Poyo.ai | Poyo.ai | `video-dubbing-and-subtitle-translation` | 1 |  |
| P3 · source-video operations on Poyo.ai | Poyo.ai | `video-upscaling` | 1 |  |
| P3 · source-video operations on Poyo.ai | Poyo.ai | `video-character-replacement` | 1 |  |
| P3 · subjects and non-URL characters | ToAPIs | `character-reference-to-video` | 1 |  |
| P3 · subjects and non-URL characters | ToAPIs | `subjects-to-video` | 1 |  |
| P3 · ToAPIs /v1/videos envelope, remix and extend | ToAPIs | `text-to-video` | 3 |  |
| P3 · ToAPIs /v1/videos envelope, remix and extend | ToAPIs | `first-frame-to-video` | 3 |  |
| P3 · ToAPIs /v1/videos envelope, remix and extend | ToAPIs | `image-reference-to-video` | 3 |  |
| P3 · ToAPIs /v1/videos envelope, remix and extend | ToAPIs | `video-extension` | 3 |  |
| P3 · ToAPIs /v1/videos envelope, remix and extend | ToAPIs | `video-remix` | 3 |  |
| P3 · ToAPIs /v1/videos envelope, remix and extend | ToAPIs | `first-and-last-frame-to-video` | 2 |  |
| P3 · ToAPIs /v1/videos envelope, remix and extend | ToAPIs | `video-reference-to-video` | 1 |  |
| P3 · video extension | Poyo.ai | `video-extension` | 1 |  |
| P3 · video extension | ToAPIs | `video-extension` | 6 |  |
| P3 · video or audio references | ToAPIs | `multimodal-reference-to-video` | 14 |  |
| P3 · video or audio references | ToAPIs | `subject-and-media-reference-to-video` | 3 |  |
| P3 · video or audio references | ToAPIs | `image-and-video-reference-to-video` | 2 |  |
| P3 · video or audio references | ToAPIs | `subject-and-motion-reference-to-video` | 2 |  |
| P3 · video or audio references | ToAPIs | `image-and-audio-reference-to-video` | 1 |  |

## Discovery-only IDs

Listed without an exact route or operation, so they add nothing to the documented count. Each needs its exact public request and result contract (Q) before the ledger can place it.

| Provider | IDs | Advertised operations |
| --- | --- | --- |
| Poyo.ai | `gpt-image-1-edit-official` | reference-image-edit |
| Poyo.ai | `gpt-image-1-official` | text-to-image |
| Poyo.ai | `gpt-image-1.5-edit-official` | reference-image-edit, mask-image-edit |
| Poyo.ai | `gpt-image-1.5-official` | text-to-image |
| Poyo.ai | `veo3.1-extend` | video-extension |
| ToAPIs | `doubao-seedream-5-0-lite` | text-to-image, reference-image-edit |
| ToAPIs | `doubao-seedream-5-0-pro-global` | text-to-image, reference-image-edit |
| ToAPIs | `gemini-2.5-flash-image-preview-vip` | none stated |
| ToAPIs | `gemini-3.1-flash-lite-image-official` | text-to-image, reference-image-edit |
| ToAPIs | `gemini-3.1-pro` | none stated |
| ToAPIs | `gemini-3.5-thinking` | none stated |
| ToAPIs | `gpt-image-2.5-flare-vip` | none stated |
| ToAPIs | `gpt-image-2.5-sunburst-vip` | none stated |
| ToAPIs | `grok-imagine-1.0` | none stated |
| ToAPIs | `grok-imagine-1.0-edit` | none stated |
| ToAPIs | `grok-imagine-video-1.5-official` | none stated |
| ToAPIs | `grok-imagine-video-official` | none stated |
| ToAPIs | `nano_banana`, `nano_banana_2`, `nano_banana_pro` | none stated |
| ToAPIs | `seedance-2-5-global` | text-to-video, image-to-video, video-reference-to-video, video-edit |
| ToAPIs | `seedance-2-fast-global` | text-to-video, image-to-video, video-reference-to-video, video-edit |
| ToAPIs | `seedance-2-global` | text-to-video, image-to-video, video-reference-to-video, video-edit |
| ToAPIs | `seedance-2-mini-global` | text-to-video, image-to-video, video-reference-to-video, video-edit |
| ToAPIs | `sora-2-official`, `veo3.1-quality` | none stated |

## Upstream since the pin

Between `747e5d7` and the current head `ec73207` (checked 2026-11-26). G2c re-pins and places these.

- Added (11): `bria-rmbg-3.0`, `ideogram-v4.6`, `ideogram-v4.6-edit`, `ltx-2.5-fast`, `ltx-2.5-pro`, `recraft-v4.1`, `recraft-v4.1-flash`, `recraft-v4.1-pro`, `recraft-v4.1-pro-vector`, `recraft-v4.1-vector`, `sync-lipsync-3`
- Removed (0): none
- Schema or billing changed (2): `kling-4.0`, `seedance-2.5`

## Option classes in the pinned schemas

Each in-scope `747e5d7` property, by the input class it needs. "Entries" counts entries carrying at least one property of the class. G2a replaces this table with per-row option gaps.

| Class | Entries | Path |
| --- | ---: | --- |
| prompt | 153 | qualified (G4, G7) |
| enum and integer options | 150 | qualified (G4, G7) within the validator |
| `image_urls` on images | 72 | qualified 1–10 (G5); more than 10: Q4 |
| `image_urls` on video | 72 | G8 frames; G8b where the schema makes them references |
| boolean options | 59 | G4 and G7 qualify booleans |
| source or reference video URLs | 41 | P3 (Poyo.ai source-video and video references) |
| output format and compression | 35 | G3 |
| output count (`n`, `max_images`, `enable_sequential`) | 34 | pinned to one output; P3 multi-output |
| free-text options (`negative_prompt`, `text` …) | 34 | G7 qualifies free text on video; Q6 on Poyo.ai images |
| `enable_safety_checker` | 31 | D4 table (G4, G6, G7) |
| image references on video | 28 | G8b |
| audio, voice and avatar inputs | 27 | P3 audio and avatars |
| arrays of objects (elements, shots, keyframes) | 21 | P3 subjects, multi-shot, keyframes |
| mask (`mask_url`) | 14 | P3 masks |
| frame URL fields (`start_image_url`, `end_image_url`) | 9 | G8 with a reviewed role note |
| untyped properties | 6 | validator gap; Q per row |
| file and webpage references | 6 | Q accepted types and fetching |
| number options | 3 | Q3 (`kling-1.6/pro` once a frame size is documented) |
| image references on images | 2 | G5 with a reviewed role note |
| parent task (`task_id`) | 2 | P3 prerequisites |

Constructs outside the validator, each until a reviewed rule covers it (G2a):

- `const` (1): `ideogram-v4.5-edit`
- `contains` (2): `kling-4.0`, `kling-4.0-flash`
- `maxContains` (2): `kling-4.0`, `kling-4.0-flash`
- `minContains` (2): `kling-4.0`, `kling-4.0-flash`
- `oneOf` (14): `flux-3-klein`, `flux-3-klein-edit`, `flux-dev`, `flux-schnell`, `seedream-4.5`, `seedream-4.5-edit`, `seedream-5.0-lite`, `seedream-5.0-lite-edit`, `wan-2.7-image`, `wan-2.7-image-pro`, `heygen-avatar-6`, `heygen-avatar-6-turbo`, `kling-4.0`, `kling-4.0-flash`
- `x-server-validation` (5): `gemini-omni-1.2-flash`, `heygen-avatar-6`, `heygen-avatar-6-turbo`, `kling-4.0`, `kling-4.0-flash`
- `x-video-duration-seconds` (4): `gemini-omni-1.1-flash`, `gemini-omni-1.2-flash`, `kling-4.0`, `kling-4.0-flash`

## Poyo.ai OpenAPI specs

Fetched 2026-11-26 from the "OpenAPI Specs" section of the [docs index](https://docs.poyo.ai/llms.txt) (SHA-256 `5b84a6d…`): 175 files, 168 English and 7 Chinese. The Chinese files are digested but not projected; the five Chinese Sora specs match their English ones. 147 English specs name models in `SubmitRequest.model.enum`, covering 210 IDs. The SHA-256 of the `sha256  path` list in index order is `3a830a6…`. A throwaway script kept outside the repository projects each spec's `input` schema, resolving local `$ref`s. A property counts when any `oneOf` or `anyOf` branch lists it, and the input is closed only when every branch is. G2a's projection replaces the script and resolves each model's own branch.

| Catalog | In-scope entries | With a spec | REST declares the field | REST closed without it | REST open without it | No spec |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| `747e5d7` | 162 | 157 | 31 | 35 | 91 | 5 |
| `ec73207` | 173 | 160 | 31 | 38 | 91 | 13 |

No spec at `747e5d7`: `gpt-image-1-edit-official`, `gpt-image-1-official`, `gpt-image-1.5-edit-official`, `gpt-image-1.5-official`, `veo3.1-extend`, all discovery-only. At `ec73207` also: `recraft-v4.1`, `recraft-v4.1-flash`, `recraft-v4.1-pro`, `recraft-v4.1-pro-vector`, `recraft-v4.1-vector`, `ltx-2.5-fast`, `ltx-2.5-pro`, `sync-lipsync-3`.

Catalog fields that a closed REST input does not list. Each is a contradiction for that option: never offered, and unknown with [question 7](SPEC-catalog-engine.md#open-questions).

- `gpt-image-2.6-fixed`: `resolution`
- `poyo-ai/image-translator`: `protect_text`, `synthesis_on_image`, `translate_on_image`
- `poyo-ai/video-translator`: `wy_need_text`, `voice_role_id`, `remove_bg_audio`

## D4 states after the ledger migration

Counted by exact model ID, because D4 applies per model. The ledger's 146 documented Poyo.ai rows hold 159 IDs. This query gives today's fields as `d4/catalogD4`:

```sh
jq '[.providers.poyo.rows[] | select(.contract == "documented") | . as $r | .ids[]
  | "\($r.d4 // "-")/\($r.catalogD4 // "-")"] | group_by(.) | map({(.[0]): length}) | add' \
  docs/media-catalog.v1.json
```

It returns `-/-` 89, `-/conflict` 2, `conflict/-` 33, `conflict/unknown` 4, `declared/-` 30, `declared/declared` 1. So 39 IDs carry `conflict`, 31 are declared and 89 have neither.

After G2a, with the REST column from the OpenAPI projection: closed-absent 39, declared 31, open-absent 89. Every `conflict` ID becomes closed-absent, and no ID is a contradiction or a refusal. Over the 162 in-scope catalog entries the split is 37, 31 and 94: the entries add the five open discovery-only IDs and lack the two closed `ideogram-v4.6` IDs, which are not pinned. ToAPIs rows keep `declared`; each descriptor review sets `open-absent` or `refused` in place of the default `unknown`.

| IDs | Ledger `d4` / `catalogD4` | Pinned catalog | REST input (OpenAPI) | New state |
| --- | --- | --- | --- | --- |
| `gpt-image-2.5-fixed` | conflict / – | closed | closed without it | closed-absent |
| `gpt-image-2.5-flare` | conflict / – | closed | closed without it | closed-absent |
| `gpt-image-2.5-sunburst` | conflict / – | closed | closed without it | closed-absent |
| `gpt-image-2.6-fixed` | conflict / – | closed | closed without it | closed-absent |
| `gpt-image-2.6-flare` | conflict / – | closed | closed without it | closed-absent |
| `gpt-image-2.6-sunburst` | conflict / – | closed | closed without it | closed-absent |
| `ideogram-v4.5` | conflict / – | closed | closed without it | closed-absent |
| `ideogram-v4.5-edit` | conflict / – | closed | closed without it | closed-absent |
| `ideogram-v4.6` | conflict / – | not pinned | closed without it | closed-absent |
| `ideogram-v4.6-edit` | conflict / – | not pinned | closed without it | closed-absent |
| `ideogram-vector-1.0/image-to-vector` | conflict / – | closed | closed without it | closed-absent |
| `ideogram-vector-1.0/text-to-vector` | conflict / – | closed | closed without it | closed-absent |
| `kling-4.0-image` | conflict / – | closed | closed without it | closed-absent |
| `kling-4.0-long-image` | conflict / – | closed | closed without it | closed-absent |
| `mai-image-2.6` | conflict / – | closed | closed without it | closed-absent |
| `mai-image-2.6-flash` | conflict / – | closed | closed without it | closed-absent |
| `mai-image-2.7` | conflict / – | closed | closed without it | closed-absent |
| `mai-image-2.7-flash` | conflict / – | closed | closed without it | closed-absent |
| `minimax-h3-image` | conflict / – | closed | closed without it | closed-absent |
| `nano-banana-2.1` | conflict / – | closed | closed without it | closed-absent |
| `poyo-ai/image-translator` | conflict / unknown | open | closed without it | closed-absent |
| `flux-3-max/image-to-video` | conflict / – | closed | closed without it | closed-absent |
| `flux-3-max/keyframes-to-video` | conflict / – | closed | closed without it | closed-absent |
| `flux-3-max/text-to-video` | conflict / – | closed | closed without it | closed-absent |
| `gemini-omni-1.1-flash` | – / conflict | closed | open without it | closed-absent |
| `gemini-omni-1.2-flash` | – / conflict | closed | open without it | closed-absent |
| `heygen-avatar-6`, `heygen-avatar-6-turbo` | conflict / – | closed | closed without it | closed-absent |
| `kling-1.6/pro` | conflict / – | closed | closed without it | closed-absent |
| `kling-1.6/standard` | conflict / – | closed | closed without it | closed-absent |
| `kling-4.0` | conflict / – | closed | closed without it | closed-absent |
| `kling-4.0-flash` | conflict / – | closed | closed without it | closed-absent |
| `omnihuman-2.0` | conflict / – | closed | closed without it | closed-absent |
| `pixverse-v6-max` | conflict / – | closed | closed without it | closed-absent |
| `poyo-ai/video-background-removal` | conflict / unknown | open | closed without it | closed-absent |
| `poyo-ai/video-translator` | conflict / unknown | open | closed without it | closed-absent |
| `poyo-ai/video-upscaler` | conflict / unknown | open | closed without it | closed-absent |
| `seedance-2.5` | conflict / – | closed | closed without it | closed-absent |
| `seedance-2.5-flash` | conflict / – | closed | closed without it | closed-absent |

## Recorded gaps

Each is an evidence question until the named source answers it. G2a re-derives option gaps from the projection; these are the ledger's own.

| Provider | Gap | IDs |
| --- | --- | --- |
| Poyo.ai | Exact public REST request and result contract unverified. | `gpt-image-1-edit-official`, `gpt-image-1-official`, `gpt-image-1.5-edit-official`, `gpt-image-1.5-official`, `veo3.1-extend` |
| Poyo.ai | The submit guide's usage prose describes an audio cover, while its summary and result contract describe cover images. | `generate-music-cover` |
| ToAPIs | Billing description additionally mentions 540p/2K but omits them from request values. Acceptance on this variant remains unknown. | `viduq4-preview` |
| ToAPIs | Current availability, operation, aliases, accepted payload and output contract. | `gemini-2.5-flash-image-preview-vip`, `gpt-image-2.5-flare-vip`, `gpt-image-2.5-sunburst-vip`, `grok-imagine-1.0`, `grok-imagine-1.0-edit`, `nano_banana`, `nano_banana_2`, `nano_banana_pro` |
| ToAPIs | Current catalog/key eligibility, alias relationship to 5.0 Pro, layer and sequential options for this ID. | `doubao-seedream-5-0-pro-global` |
| ToAPIs | Dated catalog also assigns image-generation, but Grok Image reference only lists grok-image and grok-image-2.0; exact image request contract unknown. | `grok-imagine-video-official` |
| ToAPIs | Do not inherit base-model edit, duration, resolution, D4 or region availability. Standard/Mini guide examples use the exact global ID while FAQ prose tells readers to use the base ID. The 2.5 global guide links the Seedance 2 family page, which has no global IDs. | `seedance-2-5-global`, `seedance-2-fast-global`, `seedance-2-global`, `seedance-2-mini-global` |
| ToAPIs | Eligibility on a specific account and region, fallback route operation-level coverage (including layer mode), fallback pricing and upstream behavior. | `doubao-seedream-5-5` |
| ToAPIs | Exact alias relationship, request field names and limits, sequential mode and web search for this ID. | `doubao-seedream-5-0-lite` |
| ToAPIs | Exact request, response, reference limit and upload/transport contract. | `gemini-3.1-flash-lite-image-official` |
| ToAPIs | Explicit JSON false enables fallback only when eligible. Mainland China users and China sales regions always keep fallback disabled. This is an eligibility condition, not field rejection. | `wan3.0-video`, `wan3.0-video-prime` |
| ToAPIs | Image output via the advertised openai-video compatibility family is unverified. | `doubao-seedream-4-0`, `doubao-seedream-4-5`, `flux-2-flex`, `flux-2-pro`, `flux-kontext-max`, `flux-kontext-pro`, `gemini-2.5-flash-image-preview`, `gemini-3-pro-image-preview`, `gemini-3.1-flash-image-preview`, `gpt-image-2`, `gpt-image-2.5-flare`, `gpt-image-2.5-sunburst`, `gpt-image-2.6-flare-official`, `gpt-image-2.6-sunburst-official` |
| ToAPIs | Image-producing request schema, route, operation and output shape. | `gemini-3.1-pro`, `gemini-3.5-thinking`, `grok-imagine-video-1.5-official`, `grok-imagine-video-official` |
| ToAPIs | Marketplace mentions voice reference but no voice-reference request field is documented. Extend/remix contract unknown for this ID. | `grok-video-1.5` |
| ToAPIs | Minimum valid combinations and whether an image-only or video-only request is accepted remain unclear. | `viduq3-ad`, `viduq3-drama`, `viduq3-mix` |
| ToAPIs | Reference-to-SVG acceptance. | `gpt-image-2.6-flare`, `gpt-image-2.6-sunburst` |
| ToAPIs | Scope of additional reference_images unknown. Page says exactly one input image, yet lists additional refs and seven total; preserve contradiction. Exact image-generation contract unknown despite catalog label. | `grok-imagine-video-1.5-official` |
| ToAPIs | Shared page does not resolve compatible resolutions or reference modes for every official variant. Person-generation safety setting is distinct from D4. | `Veo3.1-fast-official`, `Veo3.1-lite-official`, `Veo3.1-quality-official` |
| ToAPIs | Shared response section says model always MiniMax-H3 despite exact request variant IDs. Preserve submitted model independently. Max with disable_nsfw=true also disables prompt expansion. | `MiniMax-H3`, `MiniMax-H3-Highspeed`, `MiniMax-H3-Lite`, `MiniMax-H3-Max` |
| ToAPIs | Standard and draft-stage parameters document D4; acceptance or effect of disable_nsfw on the final draft_task_id request is unknown. | `seedance-2-5` |
| ToAPIs | The current generation page enumerates only sora-2-vvip. Confirm ongoing access and which variants can create or use a persona. | `sora-2`, `sora-2-pro` |
| ToAPIs | Web marketplace description mentions editing but the model-specific contract excludes video input. | `gemini-omni-1.2-flash-preview` |
