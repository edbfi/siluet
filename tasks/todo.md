# Foundation tasks

- [x] Install the workflow skills and record the approved direction. Verify the generated lock and project-specific install targets.
- [x] Start a clean build on Bun. Verify the page and health endpoint on a loopback address.
- [x] Run the checks in the README, including the smoke test against the built server.
- [x] Land the general Bun web workflows. Both `ci-ok` and `pr-policy` passed on [PR #1](https://github.com/edbfi/siluet/pull/1), and [CI passed on the merged commit](https://github.com/edbfi/siluet/actions/runs/44905613387).
- [x] Verify the [main ruleset](https://github.com/edbfi/siluet/rules/27793694) requires both checks from GitHub Actions. Read back the repository's merge, sign-off and Actions settings.
- [x] Add the upstream Dependabot auto-merge workflow and the full Biome migration workflow together after verifying the gate.
- [x] Verify Dependabot security updates are enabled in the [repository settings](https://github.com/edbfi/siluet/settings/security_analysis). Checked 2026-11-22.
- [ ] Confirm the central Bun maintenance token can open a maintenance PR for Siluet. The owner reads back the `edbfi-bun-maintenance` token: it covers `edbfi/siluet` with read-write Contents and Pull requests and has not expired. Close this item when the first real Bun maintenance PR opens. The [scheduled run](https://github.com/edbfi/edbfi-ci/actions/runs/44910073092) found Bun 1.4.5 clean on 2026-11-21, so it exercised discovery only. The [upstream setup](https://github.com/edbfi/edbfi-ci/blob/main/SETUP.md#credentials) lists the account-level grant.

## v0.1.0 scoped preview

Order and gates: [plan](plan.md), [D11](../docs/decisions.md#d11--v010-is-a-scoped-preview).

- [x] The bundled Poyo.ai v2 feed is refreshed first. `pricing/v2/poyo.json` includes `h3-max` (on `pricing-data` since `db0551e`, 2026-11-23) and matches `pricing-data` semantically ([#63](https://github.com/edbfi/siluet/pull/63)). On 2026-11-25 the rates equal `pricing-data` `b08488a`; only `confirmedAt` differs.
- [x] The ToAPIs collector publishes a v2 feed (`pricing-data-toapis:pricing/v2/toapis.json`) with the Seedream reference-image rate, still fails closed on any other change, and is bundled. Review adds $0.0064 per reference image to ToAPIs edits. `freshness.ts --toapis` reads v2, `--bundled-toapis` exists, and both freshness jobs (`pricing.yml` `check-freshness`, `ci.yml` `pricing-freshness`) check the published v2 feed, with `check-freshness` also checking the bundled one. [#66](https://github.com/edbfi/siluet/pull/66); [pricing run](https://github.com/edbfi/siluet/actions/runs/45527357589) published the v2 feed and kept the v1 blob, and the [dispatched CI run](https://github.com/edbfi/siluet/actions/runs/45527441871) passed `pricing-freshness`.
- [ ] On the commit to tag, after `git fetch origin pricing-data pricing-data-toapis`, this passes; it fails at 14 days or fewer. Leave out `--poyo-v1`, which would stand in for a missing Poyo.ai v2 feed. The feeds price every shipped priced operation, including `h3-max` and the Seedream reference image.
  ```sh
  git show origin/pricing-data:pricing/v2/poyo.json > /tmp/poyo-v2.json
  git show origin/pricing-data-toapis:pricing/v2/toapis.json > /tmp/toapis-v2.json
  bun scripts/pricing/freshness.ts --fail-within-days 14 --poyo-v2 /tmp/poyo-v2.json \
    --toapis /tmp/toapis-v2.json --bundled-poyo pricing/v2/poyo.json --bundled-toapis pricing/v2/toapis.json
  ```
  It passed during release preparation on 2026-11-25. The bundled Poyo.ai rates expire first, at 2026-12-24T16:04:23Z, so it fails from 2026-12-10T16:04Z. Run it again on the commit to tag.
- [x] Documentation sync, done by this PR: capability map through #61, D11, D12, the promoted decisions and the plan.
- [x] Generate one real clip per shipped video family with owner approval (2026-11-24): Poyo.ai H3 Max 5 s 480p for 50 credits, ToAPIs Seedance 2.5 4 s 480p for 77.66 credits. Both fail `verifyVideoFile` on `5321d7f`. Originals are kept outside git in `audit/realclip/`, SHA-256 `0942ac5a…be96d` (H3 Max) and `bad803dc…76363` (Seedance).
- [x] The council confirms the D6 revision for these structures: an approved plan and three code rounds ending in unanimous approval, then [#65](https://github.com/edbfi/siluet/pull/65) ([CI on the merged commit](https://github.com/edbfi/siluet/actions/runs/45525368090)).
- [x] On the release candidate, both untouched originals pass `verifyVideoFile` from `src/`, with its output and their SHA-256 recorded, and the saved bytes stay the provider's. On `6b94cd7` (2026-11-25), under each mode's limit and under the legacy limit: H3 Max `0942ac5a…be96d` 832×480, 5.1667 s, 124 video and 162 audio samples; Seedance `bad803dc…76363` 854×480, 4.064 s, 97 and 128. Auto-save verifies the downloaded scratch file and renames it into Gallery unchanged.
- [x] CI fixtures built from the recorded structures pass, while another `uuid` box, a bad JUMBF or `jumd`, a C2PA box over 1 MiB and, under the AAC priming exception, over-priming, non-1,024-sample AAC frames and an edit past the first sample are refused.
- [x] Completed, unsaved clips held for an MP4 refusal the fix now accepts re-arm once: those with unexpired links save with one status read and no generation call; expired ones settle as expired with zero status reads.
- [x] The council confirms the per-mode video Save limits spec, the implementation merges, and Review states each mode's limits ([#67](https://github.com/edbfi/siluet/pull/67), [SPEC](../docs/SPEC-video-save-limits.md)).
- [x] [#62](https://github.com/edbfi/siluet/pull/62) is rebased onto the per-mode limits with its source-length disclosure at 30 s, passes its checks and merges (`49b1451`, [CI on the merged commit](https://github.com/edbfi/siluet/actions/runs/45542430661)).
- [ ] A cross-cutting security review is recorded as one short entry in `docs/decisions.md` with its scope, date, findings and their dispositions, and every blocker is resolved or explicitly accepted by the owner. Recorded on 2026-11-25 with its fixes ([#69](https://github.com/edbfi/siluet/pull/69)); the cross-port session cookie waits on the owner.
- [x] Re-check the README against shipped behaviour after the per-mode limits and #62. Done in release preparation on `6b94cd7`. The cookie note waits on the owner's decision.
- [x] The release coverage table lists each operation as verified, Review-only or pending and cites the real-clip results, and `package.json` reads `0.1.0` on the commit to tag. The table is drafted for the owner's GitHub release, and `package.json` reads `0.1.0` from release preparation.
- [ ] Local checks and hosted `ci-ok` pass on the commit to tag, and the owner tags `v0.1.0`.

## R0 operations

- [ ] Each R0 PR passes the local checks, `ci-ok` and `pr-policy`. The pricing PRs also pass their pricing run and the failing tests listed in each PR body.
- [ ] Dispatch `pricing.yml`. `pricing-data` gains `pricing/v2/poyo.json` with `sourceDate` 2026-11-19T13:42:30Z and that day's `confirmedAt`, and the v1 blob ID is unchanged. A same-day rerun prints the skip notice. The first part holds on `pricing-data` `e763945` (2026-11-22); the skip notice is unverified.
- [ ] `check-freshness` passes for the published feeds and reports the bundled feed. `pricing:refresh` reports "updated" with both dates.
- [ ] Dispatch the `ci.yml` `pricing-freshness` job and see it pass. The last editors of the `pricing.yml` and `ci.yml` cron lines receive scheduled-failure email.
- ~~Refresh the bundled v2 feed.~~ Superseded by the v0.1.0 bundle refresh.
- [ ] The scheduled `immortality.yml` run on 2026-12-01 succeeds.

## Poyo.ai video family (R3)

- [x] Parse H3 Max from its descriptor and refuse out-of-range inputs, foreign keys and ToAPIs routing.
- [x] Classify Poyo video acknowledgements, refusals, uncertainty, throttling and status with fresh fixtures.
- [x] Split video jobs from ToAPIs correlation at every `business_id` site and poll H3 for ten minutes from its acknowledgement.
- [x] Queue, replay and track one H3 job with no second POST across restart, key changes and a late cooldown. Keep the released Seedance HMAC bytes.
- [x] Estimate H3 from the v2 `h3-max` rate with the unknown-price consent path. Keep the v1 feed bytes.
- [x] Save H3 through the D6 structural verifier and play it offline in the built studio.
- [x] After merge, a pricing run publishes `h3-max` to `pricing-data` (`db0551e`, 2026-11-23). The bundle refresh is superseded by the v0.1.0 item.
- [x] `smoke` and `native-owner` pass both video journeys on hosted Linux and macOS ([CI on `6d7838d`](https://github.com/edbfi/siluet/actions/runs/45545827248)).

## Automatic Save (D9)

- [x] Save each completed image and video with no click and no extra status read; at most two images and one video transfer at once. `auto-save.test.ts`, `gallery-download.spec.ts`.
- [x] Try a failed or incomplete download three times in all, then show Download failed; Retry download reads once, never submits and saves. `auto-save.test.ts`.
- [x] Show Download failed at once for a completion without a usable link; hold an unsupported image or clip, or a WebM, on any read. `auto-save.test.ts`, `video.test.ts`, `first-saved-image.spec.ts`.
- [x] Clear an expired intent with no request; resume a paused one after one Refresh; wait for the original key. `auto-save.test.ts`, `save-intent.test.ts`.
- [x] Count no try for shutdown, restart, a refused read gate or a failed database write; recover an interrupted attempt with one read. `auto-save.test.ts`, `save-intent.test.ts`.
- [x] Keep Remove until Download again; show File missing until Download again. `auto-save.test.ts`, `gallery-download.spec.ts`.
- [x] Upgrade a #37 installation: arm completed, unsaved jobs, keep holds and save once with no POST. `media-upgrade.test.ts`, `migrations.test.ts`.
- [x] Keep signed result links out of the database, logs and summaries. `auto-save.test.ts`.

## First saved video

- [x] Verify full-track sample accounting, timelines and decoder configuration in TypeScript (D6); the browser decodes the samples.
- [x] Verify credential revision, eligibility, review consent and one durable generation.
- [x] Verify read-only recovery, matching status, billing and read cooldowns.
- [x] Verify private Save, Range playback and removal across restart in the built studio.
- [x] Run local checks and verify offline playback in the built studio; hosted CI plays it on Linux `smoke` and macOS `native-owner`.
- [x] Review the implementation with council and verify the registry and Z-Image have landed.

## Owner authenticator and host recovery

- [x] Enroll, replace and disable an authenticator. Verify single-use recovery codes, two-step sign-in and recovery from exhausted attempt limits.
- [x] Rotate the owner session after a Security change. Clear reviewed drafts in sibling Image Studio and Video Studio tabs while the Security tab displays the new recovery codes.
- [x] Exercise stopped-service recovery through a terminal. Verify exclusive access, hidden password entry and reopening after interruption.
- [x] Upgrade an existing video installation and recover the owner. Reopen the saved PNG and MP4 and verify that provider model access survived.

## Local image preparation (R1a)

- [x] Clean JPEG and PNG in process. Keep upright JPEG entropy data byte-identical and verify re-encoded rotations against mapped source samples.
- [x] Hold one preparation slot per installation from admission through the stage write. Reserve staged copies in the shared 128 MiB scratch pool.
- [x] Retire staged copies with their sessions, and reclaim scratch only under the installation lock.
- [x] Clean one attached local copy automatically and preview it in Review.
- [x] Pass the hosted media-cleanup matrix on Linux x64 and ARM64 and macOS.

## Queue the attached file (R1b)

- [x] Queue one attached JPEG or PNG as a Seedream edit on Poyo.ai or ToAPIs: one upload of the staged bytes, then one edit (`queue.test.ts`, `local-file-review.spec.ts`).
- [x] Turn cleaning off only in Settings or during setup (D10); send an original only when it is one still SDR JPEG or PNG (`original.test.ts`, `settings-files.spec.ts`).
- [x] Retire staged copies when the setting changes, and prepare again in other tabs (`local-file-review.spec.ts`).
- [x] Keep a lost Queue answer replayable byte-for-byte without a second charge (`queue.test.ts`, `local-file-review.spec.ts`).
- [x] Fail CI when a released migration is changed, removed or backdated (`scripts/db/released-append-only.test.ts`).

## Ordered files and URLs (R2)

- [x] Edit with 1–10 ordered references mixing public URLs and local JPEG/PNG files: each file uploads once in slot order, then one edit (`ordered-queue.test.ts`, `dispatch.test.ts`, `ordered-file-edit.spec.ts`).
- [x] Review renews every slot or none; Queue claims every staged file or none and names the slots to prepare again (`stages.test.ts`, `ordered-queue.test.ts`).
- [x] Start the edit only when every file slot has a usable receipt, and keep the wallet open while any upload is unknown (`file-attempt.test.ts`, `dispatch.test.ts`).
- [x] Show each file slot's outcome, the stop reason and the hosted-copy warning in Jobs (`file-state.test.ts`, `tracking.test.ts`, `file-edit.spec.ts`).
- [x] Upgrade every R1b file job to slot 1 and keep its exact replay (`media-upgrade.test.ts`, `ordered-queue.test.ts`).

## Seedance URL keyframes (R4)

- [x] Register Animate a still and First and last frame on ToAPIs after text-to-video, with partial ledger profiles (`ledger.test.ts`).
- [x] Send each frame URL exactly as trimmed in `image_with_roles` with adaptive framing; refuse duplicates, swapped or missing roles, 2,049-byte URLs and ratios with zero calls (`keyframes.test.ts`, `request.test.ts`).
- [x] Quote the advertised token rate in both modes and bind the exact frames to Review; keep frame URLs and hosts out of job rows (`video.test.ts`).
- [x] Explain a refused or unreadable frame by operation; follow asset review past automatic tracking to Save and Retry download with one POST (`video.test.ts`, `summary.test.ts`, `tracking.test.ts`).
- [x] Review both modes by keyboard at desktop and 320 px, queue once, save and reopen offline with zero frame-host reads (`seedance-keyframes.spec.ts`).
- [x] Hosted `smoke` (Linux x64) passes the keyframe journey; `native-owner` (macOS) keeps passing its existing video checks.

## Seedance source-video edit (R5a)

- [x] Register Edit video on ToAPIs after the keyframes, with a partial ledger profile (`ledger.test.ts`).
- [x] Send one source URL exactly as trimmed in `video_with_roles` with `duration: -1` and adaptive framing; refuse a duration, ratio, 1080p, wrong role or slot count, 2,049-byte URL and non-public source with zero calls (`source-edit.test.ts`, `request.test.ts`).
- [x] Quote the $6 video-input rate, bind the five edit disclosures, the generated Save limit and exact source to Review, and keep source URLs and hosts out of job rows (`video.test.ts`).
- [x] Name the source clip in confirmed refusals and failures; keep undocumented codes uncertain; follow asset review to Save, Retry download, expiry, a saved 15-second edit and a held 31.1-second edit with one POST (`video.test.ts`, `summary.test.ts`, `tracking.test.ts`).
- [x] Review by keyboard at desktop and 320 px, queue once, save and reopen offline with zero source-host reads or DNS resolutions (`seedance-source-edit.spec.ts`).
- [x] The owner decided (2026-11-25): the edit saves up to 30 s from upstream evidence, disclosed as unverified on this route, and the source-length and cost warning stays at 30 s (`registry.test.ts`, `request.test.ts`, `source-edit.test.ts`, `tracking.test.ts`).
- [x] Hosted `smoke` (Linux x64) passes the edit journey; `native-owner` (macOS) keeps passing its existing video checks ([CI on `49b1451`](https://github.com/edbfi/siluet/actions/runs/45542430661)).
