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

Siluet runs on your machine. Claim your studio with the token printed in the server terminal, then sign in with your local username and password. In **Settings → Providers**, connect Poyo.ai or ToAPIs with your own model API key. Siluet checks the key when you submit it and shows when the provider last accepted it. Open **Image Studio** to choose a model and review its outgoing request and estimated credits offline. Seedream 5.5 accepts a prompt or an edit with 1–10 ordered public image URLs. On Poyo.ai, choose **Alibaba / Z-Image → Z-Image** to generate from a prompt or edit one public image URL. For a Z-Image edit, leave the aspect ratio at **Provider default** to omit the size from the request. A private name can help you recognize each image while composing. **Review request** shows the ordered references, the provider’s estimate and who can receive every full URL, including any signed query. For Seedream generation and editing, the **Batch** tab lets you choose 1–5 requests and up to three extra attempts per request. Return to **Review**, check the maximum number of potentially paid submissions and confirm any unknown cost. **Queue** authorizes dispatch for two minutes, even if you leave the page. Follow each request in **Jobs** and choose **Save to Gallery** on a successful result. Saved images open offline after a restart.

If Jobs says **May have been submitted**, check your provider history before authorizing another request. Siluet never automatically resends an attempt with an unknown submission outcome.

## Tech stack

| Concern | Choice |
| --- | --- |
| Language | TypeScript 6 with strict type checking |
| Framework | Svelte 5 and SvelteKit 3 with server-side rendering |
| Runtime and packages | Bun for development, CI and production |
| Local server | `@sveltejs/adapter-bun` bound to loopback |
| Database | Embedded Turso with Drizzle ORM for owner access, sessions, encrypted provider credentials, jobs and Gallery metadata |
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

Estimates use local public rates and work offline. To refresh from the published feeds, run `bun run pricing:refresh` for Poyo.ai or `bun run pricing:refresh --provider toapis` for ToAPIs. Each command updates that provider’s local cache. If a refresh fails, estimates can still use eligible cached or bundled rates. Unsupported or expired rates return an unknown total. Use `pricing:estimate --help` for options.

## Development

The embedded database driver ships binaries for Apple Silicon, 64-bit Windows (x64), and glibc Linux (x64 or ARM64).

From the repository root, install the locked dependencies, build Siluet, and start the built application:

```sh
bun ci
bun run --bun build
bun run start
```

On first start, open the printed setup URL and paste the claim token into the form. The token rotates every 15 minutes until you claim the studio. On subsequent starts, open `http://127.0.0.1:3000` and sign in.

All supported platforms use the same per-user layout. Owner data lives in `$XDG_DATA_HOME/siluet` or `~/.local/share/siluet`. Set `SILUET_DATA_DIR` to an absolute, private directory outside the Siluet checkout for a separate installation. Keep the whole directory together when backing it up with the server stopped. The database stores encrypted provider credentials and needs the separate `provider-credentials.key` file to read them. If you lose the key file, reconnect the providers in Settings.

If Settings shows **Storage repair required**, restore private permissions on the installation directory and its key file. On Linux and macOS, the directory should be owned by your account with mode `700` and the key file with mode `600`. On Windows, restrict both access lists to your account, SYSTEM, and Administrators. If the key path is a link, move the link aside and restore the regular key file from backup if available. Reload Settings after the repair.

Set `SILUET_SERVER_PORT` to change the built server's port. `GET /healthz` returns `{"status":"ok"}`. For development with automatic rebuilds, run `bun run dev`. It uses a separate `siluet-dev` data directory unless you set `SILUET_DATA_DIR`.

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

For dated model and operation coverage by provider, run `bun scripts/media-catalog/coverage.ts`. The [media catalog](docs/SPEC-media-catalog.md) defines the counts and the limits of each released operation.

See the [ground-floor spec](docs/SPEC.md), [product decisions](docs/decisions.md) and [contributor instructions](AGENTS.md).

## License

Siluet is free software licensed under the GNU Affero General Public License, version 3 or any later version (`AGPL-3.0-or-later`). See [LICENSE](LICENSE).

The bundled development skills retain their upstream licenses and notices in [docs/licenses](docs/licenses/).
