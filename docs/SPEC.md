# Siluet ground-floor spec

Siluet's first deliverable is a working local build that a contributor can verify without a provider account. The [decision record](decisions.md) sets the product direction. The production milestones below build on this foundation.

## Acceptance criteria

1. A locked Bun install produces a strict TypeScript, Svelte 5 and SvelteKit 3 application using the Bun adapter. Panda CSS generates the page styles and the page exercises Ark UI for Svelte.
2. Starting the built application listens on loopback. Opening the root page identifies Siluet. A request to `GET /healthz` returns HTTP 200 and JSON `{"status":"ok"}`.
3. Type checking, Biome, focused tests and a production build pass. A Chromium smoke test opens the built server, checks the page and verifies its health response. The [README](../README.md) lists the local commands.
4. The initial PR runs the real `ci-ok` and `pr-policy` checks. CI installs Chromium before running the smoke test. Default-branch protections and dependency auto-merge follow the upstream [edbfi-ci onboarding order](https://github.com/edbfi/edbfi-ci/blob/main/SETUP.md).

The ground floor needs no persistence, credentials, model catalog or paid submissions. Milestone 1 replaces the status fixture with the protected Svelte studio.

## First production milestones

| Order | Capability | What the creator can verify |
| --- | --- | --- |
| 1 | [Owner access](SPEC-owner-access.md) | Claim a fresh installation, enter the protected Svelte studio, sign out and sign back in after restarting. |
| 2 | [Image Studio](SPEC-image-studio.md) | Connect a provider in Settings, select a model by family, choose a connected provider and review the request with its local estimate. |
| 3 | [First saved image](SPEC-first-saved-image.md), [single-reference edit](SPEC-seedream-reference-edit.md) and [multi-reference edit](SPEC-seedream-multi-reference-edit.md) | Queue one text-to-image generation or one edit with 1–10 ordered public image URLs, follow the job, save the result and reopen it in Gallery after restarting. |

Video Studio can reuse the submission and media paths. External sign-in builds on owner access through Security settings.
