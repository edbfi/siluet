# Foundation tasks

- [x] Install the workflow skills and record the approved direction. Verify the generated lock and project-specific install targets.
- [x] Start a clean build on Bun. Verify the page and health endpoint on a loopback address.
- [x] Run the checks in the README, including the smoke test against the built server.
- [x] Land the general Bun web workflows. Both `ci-ok` and `pr-policy` passed on [PR #1](https://github.com/edbfi/siluet/pull/1), and [CI passed on the merged commit](https://github.com/edbfi/siluet/actions/runs/44905613387).
- [x] Verify the [main ruleset](https://github.com/edbfi/siluet/rules/27793694) requires both checks from GitHub Actions. Read back the repository's merge, sign-off and Actions settings.
- [x] Add the upstream Dependabot auto-merge workflow and the full Biome migration workflow together after verifying the gate.
- [ ] Grant central Bun maintenance access after the gate is active, then enable Dependabot security updates. Record any account-owner actions or credentials still unexercised.
