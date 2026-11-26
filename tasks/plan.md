# Plan: road to v0.1.0

Source: [capability map](../docs/SPEC.md#production-capability-map), [D2 coverage acceptance](../docs/SPEC.md#d2-coverage-acceptance) and [D11](../docs/decisions.md#d11--v010-waits-for-full-d2-coverage). Tasks are tracked in [todo.md](todo.md#v010-the-complete-feature-set). Merges follow the [delivery rules](../docs/decisions.md#delivery-and-migrations).

## Overview

On 2026-11-26 the owner moved v0.1.0 from a scoped preview to the complete feature set: full D2 coverage for a dated baseline. The scoped-preview phases are merged: pricing recovery, real-clip Save, per-mode limits, the Seedance URL edit, the security fixes and browser-key sessions ([#62](https://github.com/edbfi/siluet/pull/62)–[#71](https://github.com/edbfi/siluet/pull/71)). Each module below starts with its own spec and council review. Retire this plan when v0.1.0 is tagged.

## Phase 1 · follow-ups from #71, alongside the catalog spec

1. Gallery downloads: a pending state on the Download link, and downloads waiting for a read slot before they take one.
2. Session client: `send()` keeps a recovery answer across a remount that lands before the headers, and resends a `Request` with a body.
3. Key rotation on sign-in, spec first.
4. WebKit: Gallery's "can't play this video" note.
5. Firefox: the forty-tab restore journey, and the Image Studio mobile-menu journey under parallel load.

## Phase 2 · catalog engine

6. Spec the catalog engine (slice G): contract-covered rows for the Poyo.ai image and video families from the pinned catalog and for ToAPIs from curated descriptors, still WebP Save and per-model output formats, the ToAPIs inventory snapshot, data-driven Save limits, the two D4 exception paths, and Gallery's size limits raised to every provider's documented output size ([D5](../docs/decisions.md#d5--verify-gallery-images-before-saving), [D6](../docs/decisions.md#d6--verify-downloaded-video-structure-in-typescript)).
7. Implement it in slices, each reaching verified Save in the built app.

## Phase 3 · operations and inputs, after the engine where they depend on it

8. Seedance WAV reference: public URL, then local WAV.
9. Local keyframe files, and a source-video edit from one local MP4 with a TypeScript MP4 cleaner.
10. More local image formats, each qualified under the cleanup spec.
11. Layer decomposition, stored as private files with a database manifest (D3).
12. Happy Horse, extension (after its spec is re-reviewed) and the remaining documented operations.

## Phase 4 · coverage closure

13. Give every ledger pair its evidence-backed state: verified, contract-covered, provider unsupported, or unknown with its open question.
14. Verify each new video family's Save from fixtures when its output fits the D6 profile; a structure outside it needs a suitable real sample, and a new one takes a live call under D2 with express owner approval.
15. Each priced module adds its rates to the published and bundled feeds when the provider publishes them, or uses D1's unknown-price acceptance when the price is unknown.

## Phase 5 · release

16. Clean up the Impeccable and workflow-skill artifacts and files, with the scope confirmed by the owner.
17. Run a cross-cutting security review of the release candidate, update the README and draft the notes.
18. Run every D11 gate on the commit to tag, then hand the tag to the owner.

Deferred: the capability map's [not-committed list](../docs/SPEC.md#design-and-operations).

## Risks

| Risk | Mitigation |
| --- | --- |
| A provider changes a contract during the long run to the tag | Re-date the baseline and record the drift in the ledger. The catalog drift check fails on schema changes. |
| Price feeds approach expiry between releases | The weekly backstop warns. Refresh the published and bundled feeds before the tag. |
| A new mode produces a structure the verifier refuses | Fix the verifier or the mode's limits; never ship the family as verified. |
| Live verification spends credits | Each billable check needs express owner approval. |
| The real-clip originals are lost | Regenerating them needs express owner approval. Keep them by SHA-256 outside git. |
