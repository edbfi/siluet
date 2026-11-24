# Foundation tasks

- [x] Install the workflow skills and record the approved direction. Verify the generated lock and project-specific install targets.
- [x] Start a clean build on Bun. Verify the page and health endpoint on a loopback address.
- [x] Run the checks in the README, including the smoke test against the built server.
- [x] Land the general Bun web workflows. Both `ci-ok` and `pr-policy` passed on [PR #1](https://github.com/edbfi/siluet/pull/1), and [CI passed on the merged commit](https://github.com/edbfi/siluet/actions/runs/44905613387).
- [x] Verify the [main ruleset](https://github.com/edbfi/siluet/rules/27793694) requires both checks from GitHub Actions. Read back the repository's merge, sign-off and Actions settings.
- [x] Add the upstream Dependabot auto-merge workflow and the full Biome migration workflow together after verifying the gate.
- [x] Verify Dependabot security updates are enabled in the [repository settings](https://github.com/edbfi/siluet/settings/security_analysis). Checked 2026-11-22.
- [ ] Confirm the central Bun maintenance token can open a maintenance PR for Siluet. The owner reads back the `edbfi-bun-maintenance` token: it covers `edbfi/siluet` with read-write Contents and Pull requests and has not expired. Close this item when the first real Bun maintenance PR opens. The [scheduled run](https://github.com/edbfi/edbfi-ci/actions/runs/44910073092) found Bun 1.4.5 clean on 2026-11-21, so it exercised discovery only. The [upstream setup](https://github.com/edbfi/edbfi-ci/blob/main/SETUP.md#credentials) lists the account-level grant.

## R0 operations

- [ ] Each R0 PR passes the local checks, `ci-ok` and `pr-policy`. The pricing PRs also pass their pricing run and the failing tests listed in each PR body.
- [ ] Dispatch `pricing.yml`. `pricing-data` gains `pricing/v2/poyo.json` with `sourceDate` 2026-11-19T13:42:30Z and that day's `confirmedAt`, and the v1 blob ID is unchanged. A same-day rerun prints the skip notice.
- [ ] `check-freshness` passes for the published feeds and reports the bundled feed. `pricing:refresh` reports "updated" with both dates.
- [ ] Dispatch the `ci.yml` `pricing-freshness` job and see it pass. The last editors of the `pricing.yml` and `ci.yml` cron lines receive scheduled-failure email.
- [ ] Refresh the bundled v2 feed. It matches `pricing-data` semantically, the full checks pass, and the next `check-freshness` reports about 30 days.
- [ ] The scheduled `immortality.yml` run on 2026-12-01 succeeds.

## Poyo.ai video family (R3)

- [x] Parse H3 Max from its descriptor and refuse out-of-range inputs, foreign keys and ToAPIs routing.
- [x] Classify Poyo video acknowledgements, refusals, uncertainty, throttling and status with fresh fixtures.
- [x] Split video jobs from ToAPIs correlation at every `business_id` site and poll H3 for ten minutes from its acknowledgement.
- [x] Queue, replay and track one H3 job with no second POST across restart, key changes and a late cooldown. Keep the released Seedance HMAC bytes.
- [x] Estimate H3 from the v2 `h3-max` rate with the unknown-price consent path. Keep the v1 feed bytes.
- [x] Save H3 through the D6 structural verifier and play it offline in the built studio.
- [ ] After merge, a pricing run publishes `h3-max` to `pricing-data` and the bundle refresh brings it into `pricing/v2/poyo.json`.
- [ ] `smoke` and `native-owner` pass both video journeys on hosted Linux and macOS.

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
