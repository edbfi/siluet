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

Siluet is a private image and video studio that runs on your own machine. Connect your Poyo.ai or ToAPIs key and review each request before anything is sent: Review shows an estimate when a rate is known, or asks you to accept an unknown price. Gallery saves results that pass verification and stay within the mode's limits, and they open offline.

## Quick start

Requires [Bun](https://bun.sh) on Linux or macOS. Tested on glibc Linux (x64 and ARM64) and Apple Silicon macOS.

```sh
bun ci
bun run --bun build
bun run start
```

Open the setup URL printed in the terminal, paste the claim token, and choose a password. Later starts open at `http://127.0.0.1:3000`.

- Data lives in `~/.local/share/siluet` (or `$XDG_DATA_HOME/siluet`). Set `SILUET_DATA_DIR` for a separate installation, and back up the whole directory while Siluet is stopped.
- Image Studio and Video Studio share one Gallery. Video Studio creates clips from a prompt, optionally guided by public frame URLs, or edits a clip from a public video URL. Review shows the limits each clip must meet to save there.
- Siluet removes metadata from every attached image before upload. Turn this off in Settings → Attached files.
- An authenticator is optional. Add one in Settings → Security.
- Each browser keeps a sign-in key for this exact address and needs JavaScript. Another port, `[::1]` instead of `127.0.0.1`, cleared site data or this upgrade means signing in again.
- Locked out? Stop Siluet and run `bun run owner:recover`.
- Refresh price estimates with `bun run pricing:refresh` (add `--provider toapis` for ToAPIs) before the expiry Review shows.

## Tech stack

| Concern | Choice |
| --- | --- |
| Language | TypeScript with strict type checking |
| Framework | Svelte 5 and SvelteKit 3 with server-side rendering |
| Runtime | Bun, with `@sveltejs/adapter-bun` bound to loopback |
| Database | Embedded Turso with Drizzle ORM |
| Styling | Panda CSS and Ark UI for Svelte |
| Media | sharp for images; TypeScript MP4 checks for video |
| Checks | Biome, `svelte-check`, prek, Bun's test runner and Playwright |

## Development

```sh
bun run dev
bun run --bun check
bun run --bun lint
bun run --bun test
bun test --timeout 60000 ./tests/media-cleanup
bun run --bun build
bunx --bun --no-install playwright install chromium
bun run --bun smoke
prek run --all-files --hook-stage manual
```

See the [spec](docs/SPEC.md), [decisions](docs/decisions.md) and [contributor guide](AGENTS.md).

## License

[AGPL-3.0-or-later](LICENSE). Bundled development skills keep their upstream licenses in [docs/licenses](docs/licenses/).
