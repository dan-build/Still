# Security

Still is a secret manager, so security reports are the most valuable contribution you can make.

## Reporting a vulnerability

Please **do not** open a public issue. Report privately through GitHub: open the repository's **Security** tab and choose **Report a vulnerability**. Include the version or commit you tested, your operating system, and the steps to reproduce.

## Supported versions

Still is pre-1.0. Only the latest commit on `main` gets fixes.

## What Still protects today

- **Secret values are encrypted at rest.** Your master password goes through Argon2id (libsodium `crypto_pwhash`, SENSITIVE limits) to unlock an app key. The app key wraps a separate key for each Lens, and each item is encrypted with its own subkey using XChaCha20-Poly1305. All cryptography comes from libsodium.
- **Nothing leaves the device.** There are no accounts, no servers, no telemetry and no network calls.
- **The app's page runs under a strict Content Security Policy.** It can load only its own bundled files, and can't fetch from the network, run injected inline scripts or use `eval`.

## What Still does not protect yet

These are known, and being worked on:

- **Lens names, item labels, item types, dates and counts are stored unencrypted.** Only the secret values are encrypted.
- **The vault lives in the app's webview storage.** Keys stay in webview memory while the app is unlocked. Lock clears the app's own copies, but the crypto library's memory may keep traces until encryption moves into Rust.
- **Copied secrets stay on the clipboard.** Clipboard history tools may keep them.
- **There is no auto-lock.**

## Where the vault is stored (macOS)

- **Release builds:** `~/Library/WebKit/com.still.app/`
- **Development builds** (`npm run tauri:dev`): `~/Library/WebKit/still/`. This is a separate, independent vault.
