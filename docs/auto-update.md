# Auto-update setup

Outset uses [tauri-plugin-updater] to check a manifest on launch and
install signed updates in place. Releases are built and published by
GitHub Actions on every `v*` tag push.

[tauri-plugin-updater]: https://v2.tauri.app/plugin/updater/

## One-time setup

### 1. Generate a signing keypair

The private key signs every release artifact; the matching public key
is baked into the app binary so it can verify what it downloads.

```bash
yarn tauri signer generate -w ~/.tauri/outset.key
```

This writes the private key to `~/.tauri/outset.key` and prints the
public key. **Never commit either of these.** Keep the private key
file outside the repo (e.g. in `~/.tauri/`).

### 2. Wire the public key into the app

Open `src-tauri/tauri.conf.json` and replace the placeholder under
`plugins.updater.pubkey` with the public key you just generated:

```json
"plugins": {
  "updater": {
    "endpoints": ["https://github.com/mattproch/outset/releases/latest/download/latest.json"],
    "pubkey": "dW50cnVzdGVkIGNvbW1lbnQ6..."
  }
}
```

The endpoint already points at the `mattproch/outset` repo and resolves
to whichever release is marked "latest" — the workflow attaches a
`latest.json` to every release.

Commit and push.

### 3. Add the secrets to GitHub

In **Settings → Secrets and variables → Actions** on your repo, add:

- `TAURI_SIGNING_PRIVATE_KEY` — the **contents** of `~/.tauri/outset.key`.
- `TAURI_SIGNING_PRIVATE_KEY_PASSWORD` — the password you set when
  generating the key (or empty if none).

The release workflow reads these and signs each artifact during build.

## Cutting a release

```bash
# bump version in src-tauri/tauri.conf.json AND package.json (must match)
git commit -am "Release v0.0.2"
git tag v0.0.2
git push origin main --tags
```

The `Release` workflow (`.github/workflows/release.yml`) triggers on
the tag push:

1. Builds for macOS arm64 (Apple Silicon) and x86_64 (Intel) in parallel.
2. Signs each artifact with the private key.
3. Creates a GitHub Release named `Outset v0.0.2`.
4. Attaches the bundles plus a `latest.json` manifest pointing at them.

Users on prior versions see the update banner in the bottom-right of
the app on next launch. Click **Install** → download + verify + apply
+ relaunch.

## How verification works

When the app calls `check()`, it:

1. Fetches `latest.json` from the configured endpoint.
2. Compares the `version` field to the running app's `tauri.conf.json` version.
3. If newer, returns the platform-specific URL + signature.

When the app calls `downloadAndInstall()`, it:

1. Downloads the artifact.
2. Verifies the minisign signature against the embedded public key.
3. Refuses to install on signature mismatch — a compromised CDN can't
   push tampered builds.

## Local development

`yarn tauri dev` runs against the source tree, not a release artifact.
The updater check still fires but `latest.json`'s version normally
matches or trails the dev binary's version, so the banner stays
hidden. To test the banner end-to-end you need to publish a real
release with a higher version number than the local build.

If `check()` errors (e.g. the endpoint is unreachable), the app logs
a warning to the console and stays silent — no banner, no crash. Open
DevTools to see the warning.

## Skipping the auto-updater for a build

Comment out the `tauri_plugin_updater::Builder::new().build()` line in
`src-tauri/src/lib.rs` and the plugin won't initialize. Useful for
debug builds or one-off distributions.
