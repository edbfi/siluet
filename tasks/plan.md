# Plan: road to v0.1.0

Source: [capability map](../docs/SPEC.md#production-capability-map) and [D11](../docs/decisions.md#d11--v010-is-a-scoped-preview). Tasks are tracked in [todo.md](todo.md#v010-scoped-preview).

## Overview

v0.1.0 is a scoped preview of what main verifies when it is tagged. The steps below close the release gates in dependency order, then later work follows. Retire this plan when v0.1.0 is tagged.

## Lanes

Lanes run in parallel where the order allows. One integrator merges in order and owns migrations and the recovery fingerprint. Port each candidate branch onto current main slice by slice, and name a slice's migration at merge time so it sorts after every released one.

## Order to v0.1.0

1. **Pricing recovery.** Fix the ToAPIs collector for the new Seedream image-input row; it fails closed on any table change. Refresh the bundled feeds, including Poyo.ai `h3-max`.
2. **Documentation sync.** Capability map, promoted decisions and this plan.
3. **Real clip per shipped video family.** One ToAPIs Seedance 2.5 clip and one Poyo.ai H3 Max clip pass `verifyVideoFile`. Use existing clips first; a new generation needs owner approval per family.
4. **Per-mode video Save limits.** Spec, council, implementation. Then rebase [#62](https://github.com/edbfi/siluet/pull/62) (Seedance URL edit) without its over-12 s disclosure and merge it.
5. **Cross-cutting security review**, recorded with its findings and dispositions.
6. **README essentials** for a creator.
7. **Release preparation.** Release notes list each operation as verified, Review-only or pending. Set `package.json` to `0.1.0` and hand the tag to the owner.

### Checkpoint: release

- [ ] Every [D11](../docs/decisions.md#d11--v010-is-a-scoped-preview) gate holds on the commit to tag.

## After v0.1.0

1. Slice G, the catalog engine, spec first.
2. R6a WAV audio reference: public URL, then local WAV.
3. R10 layer decomposition.
4. R5b source-video edit from one local MP4.
5. R11 Happy Horse.
6. R12 extension, after its spec is re-reviewed.

Deferred: R7 external sign-in, passkeys, MKV, metadata export, Gallery paging, cancellation and ToAPIs balance.

## Risks

| Risk | Mitigation |
| --- | --- |
| A real clip fails `verifyVideoFile` | Fix the verifier or the per-mode limits before tagging; do not ship the family as verified. |
| macOS runners stay unavailable, so `ci-ok` fails on main | Rerun the cancelled jobs; the tagged commit needs a green run. |
| Feeds age past 30 days before the tag | Refresh the bundle in release preparation. |
