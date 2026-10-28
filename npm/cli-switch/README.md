# @spec-ade/cli-switch

Run [Cli-Switch](https://viber.vn) in your browser — no desktop install required.

```bash
npx -y @spec-ade/cli-switch
```

This starts a local server and opens the Cli-Switch UI in your default browser.

## Options

```
-p, --port <PORT>    Port to listen on (default: an OS-assigned free port)
    --host <HOST>    Address to bind (default: 127.0.0.1)
    --no-open        Do not open a browser automatically
    --token <TOKEN>  Require this bearer token on /api/* (default: none)
-h, --help           Print help
```

## Security

The server binds to `127.0.0.1` by default, and the API is **unauthenticated**
unless you pass `--token`.

Loopback on its own is not a security boundary. With no token, any process on
the machine — and, via DNS rebinding, a page you have open from an unrelated
site — can read and change your provider configuration. That includes reading
your API keys and writing MCP entries, which your CLI tools later execute.

Pass a token to close that:

```bash
npx -y @spec-ade/cli-switch --token "$(openssl rand -hex 32)"
```

The printed URL then includes the token, and the browser stores it for later
visits. Because the value is yours rather than generated, it stays the same
across restarts and a bookmarked URL keeps working.

Use a token whenever the machine is shared, and always when binding a
non-loopback address. Binding `--host 0.0.0.0` exposes your provider
configuration to anyone who can reach the port; prefer an SSH tunnel or VPN
over exposing it directly.

## Supported platforms

Windows, macOS, and Linux, on x64 and arm64. Only the binary matching your
platform is downloaded — it ships as an optional dependency, so an install
pulls this package plus one platform package, not all six.

## Releasing (maintainers)

Publishing to npm is automated by `.github/workflows/npm-release.yml`:

- **Publishing a GitHub release** (the normal path) builds all six platform
  binaries and publishes them plus the launcher.
- **Pushing an `npm-v*` tag** does the same, for publishing npm-only fixes
  without cutting a desktop release.
- **Running the workflow manually** defaults to a dry run — it builds and packs
  but publishes nothing. Untick `dry_run` to publish for real.

The version comes from the release tag, not from the checked-in
`package.json` files (whose versions are placeholders that CI overwrites via
`npm/set-version.mjs`). The tag must match the app version in the repo's root
`package.json`, so bump that before tagging.

Requires an `NPM_TOKEN` secret on the `release` environment. Re-running a
finished release is safe: already-published versions are skipped rather than
failing the run.
