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

Siluet is a private image and video studio that runs on your own machine. Connect your Poyo.ai or ToAPIs key, review each request and its estimated cost before anything is sent, and follow the job until you save the result.
Saved images and videos stay in your local Gallery and open offline.

## Quick start

Requires [Bun](https://bun.sh) on Apple Silicon macOS, x64 Windows, or glibc Linux (x64 or ARM64).

```sh
bun ci
bun run --bun build
bun run start
```

Open the setup URL printed in the terminal, paste the claim token, and choose a password. Later starts open at `http://127.0.0.1:3000`.

- Data lives in `~/.local/share/siluet` (or `$XDG_DATA_HOME/siluet`). Set `SILUET_DATA_DIR` for a separate installation, and back up the whole directory while Siluet is stopped.
- Saving videos needs the qualified FFmpeg build. Set `SILUET_FFMPEG_DIR` as described in [D6](docs/decisions.md#d6--verify-stored-video-samples-before-gallery-publication).
- Locked out? Stop Siluet and run `bun run owner:recover`.
- Refresh price estimates with `bun run pricing:refresh` (add `--provider toapis` for ToAPIs) before the expiry Review shows.

## Development

```sh
bun run dev
bun run --bun check
bun run --bun lint
bun run --bun test
bun run --bun build
bunx --bun --no-install playwright install chromium
bun run --bun smoke
prek run --all-files --hook-stage manual
```

See the [spec](docs/SPEC.md), [decisions](docs/decisions.md) and [contributor guide](AGENTS.md).

## License

[AGPL-3.0-or-later](LICENSE). Bundled development skills keep their upstream licenses in [docs/licenses](docs/licenses/).
