<p align="center">
  <img src="src/lib/assets/siluet-icon.svg" alt="Siluet logo" width="160" height="160">
</p>

<h1 align="center">Siluet</h1>

<p align="center">
  <strong>A personal studio for generating and editing images and video</strong>
</p>

<p align="center">
  <a href="https://github.com/edbfi/siluet/blob/main/LICENSE"><img src="https://img.shields.io/badge/license-AGPL--3.0--or--later-blue.svg?style=flat" alt="License: AGPL-3.0-or-later"></a>
  <a href="https://github.com/oven-sh/bun" title="Bun source"><img src="https://img.shields.io/badge/Bun-000000?style=flat&amp;logo=bun&amp;logoColor=white" alt="Bun"></a>
  <a href="https://github.com/sveltejs/kit" title="SvelteKit source"><img src="https://img.shields.io/badge/SvelteKit-FF3E00?style=flat&amp;logo=svelte&amp;logoColor=white" alt="SvelteKit"></a>
  <a href="https://github.com/microsoft/TypeScript" title="TypeScript source"><img src="https://img.shields.io/badge/TypeScript-3178C6?style=flat&amp;logo=typescript&amp;logoColor=white" alt="TypeScript"></a>
  <a href="https://github.com/edbfi/siluet/actions/workflows/ci.yml?query=branch%3Amain"><img src="https://img.shields.io/github/actions/workflow/status/edbfi/siluet/ci.yml?branch=main&amp;event=push&amp;label=CI&amp;style=flat" alt="CI on main"></a>
</p>

Siluet runs on your machine. The current build serves a studio status page and a health check. The first planned integrations are ToAPIs and Poyo.ai. You’ll be able to use either provider independently, with your own API key, and save the results locally.

## Tech stack

| Concern | Choice |
| --- | --- |
| Language | TypeScript 6 with strict type checking |
| Framework | Svelte 5 and SvelteKit 3 with server-side rendering |
| Runtime and packages | Bun for development, CI and production |
| Local server | `@sveltejs/adapter-bun` bound to loopback |
| Database (planned) | Embedded Turso with Drizzle ORM, starting with the first approved feature that needs persistence |
| Styling and components | Panda CSS 2 and Ark UI for Svelte |
| Code checks | Biome, `svelte-check` and prek |
| Tests | Bun’s test runner and a Playwright smoke test in Chromium |

## Offline studio preview

Run `bun design/workspace/export.js` and open `design/workspace/workspace.html` in a browser. Use a demo key or choose **Explore without keys**. The preview runs locally with simulated jobs and balances. Review shows an estimate from the bundled rates. To use rates you have refreshed locally, rebuild the preview with `bun design/workspace/export.js --local-pricing`.

## Credit estimates

```sh
bun run pricing:estimate --model seedream-5.5 --operation edit --resolution 2K --references 2 --batch 5
bun run pricing:estimate --provider toapis --model doubao-seedream-5-5 --size 2K
```

Estimates use bundled public rates offline. After the repository publishes its first feed for a provider, run `bun run pricing:refresh` for Poyo.ai or `bun run pricing:refresh --provider toapis` for ToAPIs. Until then, the refresh command reports that the feed is unavailable and estimates use local rates. Unsupported or expired rates return an unknown total. Use `pricing:estimate --help` for options.

## Development

From the repository root, install the locked dependencies, build Siluet, and start the built application:

```sh
bun ci
bun run --bun build
bun run start
```

Open `http://127.0.0.1:3000`. Set `SILUET_SERVER_PORT` to change the built server's port. `GET /healthz` returns `{"status":"ok"}`. For development with automatic rebuilds, run `bun run dev`.

Run the local checks and install Playwright's matching Chromium before the browser smoke test:

```sh
bun run --bun check
bun run --bun lint
bun run --bun test
bun run --bun build
bunx --bun --no-install playwright install chromium
bun run --bun smoke
prek run --all-files --hook-stage manual
```

On a Linux runner that needs Chromium system libraries, pass `--with-deps` to the Playwright install command.

See the [ground-floor spec](docs/SPEC.md), [product decisions](docs/decisions.md) and [contributor instructions](AGENTS.md).

## License

Siluet is free software licensed under the GNU Affero General Public License, version 3 or any later version (`AGPL-3.0-or-later`). See [LICENSE](LICENSE).

The bundled development skills retain their upstream licenses and notices in [docs/licenses](docs/licenses/).
