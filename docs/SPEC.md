# Siluet ground-floor spec

Siluet's first deliverable is a working local build that a contributor can verify without a provider account. The [decision record](decisions.md) sets the product direction. Product modules will have separate specs after the owner approves Siluet's capability map.

## Acceptance criteria

1. A locked Bun install produces a strict TypeScript, Svelte 5 and SvelteKit 3 application using the Bun adapter. Panda CSS generates the page styles and the page exercises Ark UI for Svelte.
2. Starting the built application listens on loopback. Opening the root page identifies Siluet. A request to `GET /healthz` returns HTTP 200 and JSON `{"status":"ok"}`.
3. Type checking, Biome, focused tests and a production build pass. A Chromium smoke test opens the built server, checks the page and verifies its health response. The [README](../README.md) lists the local commands.
4. The initial PR runs the real `ci-ok` and `pr-policy` checks. CI installs Chromium before running the smoke test. Default-branch protections and dependency auto-merge follow the upstream [edbfi-ci onboarding order](https://github.com/edbfi/edbfi-ci/blob/main/SETUP.md).

The ground floor needs no persistence, credentials, model catalog or paid submissions. Its page is a build fixture. Production UI follows the owner's choice of mockup.
