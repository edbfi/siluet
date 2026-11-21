# Foundation tasks

- [x] Install the workflow skills and record the approved direction. Verify the generated lock and project-specific install targets.
- [x] Start a clean build on Bun. Verify the page and health endpoint on a loopback address.
- [x] Run the checks in the README, including the smoke test against the built server.
- [ ] Land the general Bun web workflows. Observe passing `ci-ok` and `pr-policy` runs for the foundation PR and verify the merge.
- [ ] Read back the main ruleset and repository settings. Once the required checks are in place, add `dependabot-auto-merge.yml` and restore the full upstream `biome-migrate.yml` together. Its `apply` output and `enable` job re-enable auto-merge on the migrated PR head.
- [ ] Grant central Bun maintenance access after the gate is active, then enable Dependabot security updates. Record any account-owner actions or credentials still unexercised.
