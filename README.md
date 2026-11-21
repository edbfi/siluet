# Siluet

Siluet is a personal studio for generating and editing images and video through your choice of API provider. The first providers planned are ToAPIs and Poyo.ai. The current foundation runs locally and serves a page and a health check. Provider integrations are planned.

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
