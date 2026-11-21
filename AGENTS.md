# Working on Siluet

Read the [ground-floor spec](docs/SPEC.md) and [decisions](docs/decisions.md). Siluet has its own capability map, milestones and releases. Author its code, fixtures and designs from scratch. Keep the old Poyo Studio checkout and history out of research and implementation.

Keep documentation short and tied to a reader and task. Prefer an existing README or decision entry. Keep provider evidence with the adapter or test that uses it, and omit standalone research reports and unused fixtures. Preserve required license notices.

## From a requirement to a release

- Use `spec-driven-development` for the capability map in `docs/SPEC.md` and for a module's `docs/SPEC-<id>.md`. The owner approves the map and each product module spec before implementation. Bring changes to audience, access, spending or product scope back to the owner with a recommendation.
- Use `planning-and-task-breakdown` for a short `tasks/plan.md` and a verifiable `tasks/todo.md`. Retire the plan when its work is complete. Keep durable decisions and their reasons in `docs/decisions.md`.
- Use `incremental-implementation` and `test-driven-development` to deliver one observable outcome at a time. Reproduce a failure or specify the expected behavior with a failing test, then run the focused checks as the code changes.
- Use `code-review-and-quality` before filing. Trace routes, imports, failure paths and supported model inputs. Remove code made obsolete by the change. Run the [local checks](README.md#development) before committing.
- Use council independently for consequential decisions and reviews. Verify findings against official sources or tests. For design, use Impeccable and the frontend design skill with the same task and fixtures across mockups. The owner chooses the visual direction.

## Module boundaries

Organize files by responsibility and domain throughout the repository. Add a category when real files belong together. Give each file one reason to change, with a descriptive name such as `submission.ts` or `status.ts`. Keep private helpers with their caller.

- Keep SvelteKit route handlers and job runners thin. Put multi-step orchestration under `src/lib/server/services/<domain>/`.
- Give each provider a server-only home under `src/lib/server/providers/<provider>/`. Group image and video operations, model inputs, uploads and job handling within the provider as its contract requires. Share only behavior evidenced by multiple adapters. Providers have no dependency on one another.
- Put storage operations behind focused database functions when an approved module first needs persistence. Keep provider calls out of the storage layer.
- Put types and behavior that can reach the browser under `src/lib/shared/<domain>/`. Keep secrets, environment access and provider requests under `src/lib/server/`. Group components by the feature that uses them.
- Keep focused tests near the behavior they exercise. Put browser tests in `tests/browser/`. Keep generated files under their tool's control.

## Provider work

Research the provider's own documentation. Record the source and model-specific evidence for inputs, uploads, submission acknowledgements, job IDs and statuses, result retrieval, expiry and retry guarantees. Preserve unknowns. Author fresh fixtures for CI, including confirmed failure, uncertain submission and failed download. A live billable generation or edit requires express owner approval. The module spec defines credential handling, media access and retention, and diagnostic redaction before implementation.

## Tools and pull requests

Use Bun or Bunx for JavaScript runtimes, packages, installers and scripts. Use Biome and prek for local checks. The general [edbfi-ci templates](https://github.com/edbfi/edbfi-ci/tree/main/templates) are the automation source.

Use signed-off Conventional Commits (`git commit -s`). File PRs with `file-pr` and use `babysit-pr` through Ready. At Ready, squash-merge against the reviewed head SHA. After GitHub reports `MERGED`, verify each branch tip matches that head before removing the PR worktree and branches. Report a mismatch or another stopping condition to the owner. Finish with a clean `main` at `origin/main`.

## Project skills

Codex discovers the locked workflow skills in `.agents/skills/`. Claude Code loads them through project-local links in `.claude/skills/`. Use the installers to upgrade and leave their output untouched. To reproduce the selection, run these commands from the repository root in a POSIX shell.

```sh
DO_NOT_TRACK=1 bunx --bun skills@1.9.0 add 'addyosmani/agent-skills#0.6.17' \
  -a codex -a claude-code -s $(jq -r '.skills | keys[]' skills-lock.json) -y
DO_NOT_TRACK=1 bunx --bun impeccable@4.10.0 install \
  --providers=codex,claude --scope=project --no-hooks --yes
```

Impeccable installs a harness-specific build in each project's skills directory. Compare these builds to the matching upstream `skill-v<version>` tag after installation. During design work, use the project-local launcher in `.agents/skills/impeccable/scripts/`. Start interactive copy editing with `IMPECCABLE_LIVE_COPY_AGENT=chat` to keep edits in the current agent session.
