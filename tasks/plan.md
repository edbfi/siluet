# Plan: road to v0.1.0

Source: [capability map](../docs/SPEC.md#production-capability-map) and [D11](../docs/decisions.md#d11--v010-is-a-scoped-preview). Tasks are tracked in [todo.md](todo.md#v010-scoped-preview). Merges follow the [delivery rules](../docs/decisions.md#delivery-and-migrations).

## Overview

v0.1.0 is a scoped preview of what main verifies when it is tagged. The phases below close the D11 gates in dependency order, then later work follows. This documentation sync is done when its PR merges. Retire this plan when v0.1.0 is tagged.

## Phase 1 · in parallel

1. **Pricing recovery.** Refresh the bundled Poyo.ai v2 feed with `h3-max` first. Then publish a ToAPIs v2 feed that prices Seedream 5.5 reference images ($0.0064 each, added 2026-11-24), with the collector still failing closed on any other change, and bundle it.
2. **Real clips save.** The owner-approved clips from 2026-11-24 (Poyo.ai H3 Max, 50 credits; ToAPIs Seedance 2.5, 77.66 credits) both fail `verifyVideoFile` on `5321d7f`: a top-level C2PA `uuid` box on both, and on Seedance an AAC track whose `mdhd` excludes its one priming access unit. Accept exactly these structures under a council-confirmed D6 revision and re-arm the clips Save already held for them. The originals stay outside git in the orchestration audit directory (`audit/realclip/`), identified by SHA-256.

### Checkpoint: real clips

- [ ] The D6 revision is council-confirmed.
- [ ] Both untouched originals pass `verifyVideoFile` from `src/`, with the output and SHA-256 recorded; the fixture refusals and the one-time re-arm hold ([todo](todo.md#v010-scoped-preview)).
- [ ] `ci-ok` is green on the merged commit.

## Phase 2 · after the real-clip fix

Per-mode limits and Phase 1's real-clip fix both touch `mp4.ts`, so limits wait for the real-clip fix; #62 follows the limits in the owner-approved order.

3. **Per-mode video Save limits.** Spec, council, implementation.
4. **Seedance URL edit.** Rebase [#62](https://github.com/edbfi/siluet/pull/62) onto the per-mode limits with its source-length disclosure at 30 s, then merge it.

### Checkpoint: video modes

- [ ] Review states each mode's limits, and #62 is merged with green checks.

## Phase 3 · last

5. **Cross-cutting security review**, recorded as one short entry in [decisions](../docs/decisions.md).
6. **README re-check** against shipped behaviour.
7. **Release preparation.** Write the coverage table for the GitHub-generated notes, citing the real-clip results from Phase 1. Set `package.json` to `0.1.0` and hand the tag to the owner.

### Checkpoint: release

- [ ] Every [D11](../docs/decisions.md#d11--v010-is-a-scoped-preview) gate holds on the commit to tag.

## After v0.1.0

1. Catalog engine (slice G), spec first.
2. WAV audio reference (R6a): public URL, then local WAV.
3. Layer decomposition (R10).
4. Source-video edit from one local MP4 (R5b).
5. Happy Horse (R11).
6. Extension (R12), after its spec is re-reviewed.

Deferred: external sign-in (R7), passkeys, MKV, metadata export, Gallery paging, cancellation and ToAPIs balance.

## Risks

| Risk | Mitigation |
| --- | --- |
| A new mode or the Seedance URL edit (#62) produces a structure the verifier refuses | The tag waits ([D11](../docs/decisions.md#d11--v010-is-a-scoped-preview)). Fix the verifier or the mode's limits; never ship the family as verified. |
| The real-clip originals are lost | Regenerating them needs express owner approval. Keep them by SHA-256 outside git. |
| macOS runners stay unavailable, so `ci-ok` fails on main | Rerun the cancelled jobs; the tagged commit needs a green run. |
| Feeds fall within 14 days of expiry before the tag | Refresh the published and bundled feeds in release preparation. |
