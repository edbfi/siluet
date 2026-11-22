# Foundation tasks

- [x] Install the workflow skills and record the approved direction. Verify the generated lock and project-specific install targets.
- [x] Start a clean build on Bun. Verify the page and health endpoint on a loopback address.
- [x] Run the checks in the README, including the smoke test against the built server.
- [x] Land the general Bun web workflows. Both `ci-ok` and `pr-policy` passed on [PR #1](https://github.com/edbfi/siluet/pull/1), and [CI passed on the merged commit](https://github.com/edbfi/siluet/actions/runs/44905613387).
- [x] Verify the [main ruleset](https://github.com/edbfi/siluet/rules/27793694) requires both checks from GitHub Actions. Read back the repository's merge, sign-off and Actions settings.
- [x] Add the upstream Dependabot auto-merge workflow and the full Biome migration workflow together after verifying the gate.
- [x] Verify Dependabot security updates are enabled in the [repository settings](https://github.com/edbfi/siluet/settings/security_analysis). Checked 2026-11-22.
- [ ] Confirm the central Bun maintenance token can open a maintenance PR for Siluet. The [scheduled run](https://github.com/edbfi/edbfi-ci/actions/runs/44910073092) found Bun 1.4.5 clean on 2026-11-21, so it exercised discovery only. The [upstream setup](https://github.com/edbfi/edbfi-ci/blob/main/SETUP.md#credentials) lists the account-level grant.
