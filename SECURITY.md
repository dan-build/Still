# Security

Still is a secret manager, so security reports are the most valuable contribution you can make.

## Reporting a vulnerability

Please **do not** open a public issue. Report privately through GitHub: open the repository's **Security** tab and choose **Report a vulnerability**. Include the version or commit you tested, your operating system, and the steps to reproduce.

## Supported versions

Still is pre-1.0. Only the latest commit on `main` gets fixes.

## What Still protects today

- **Secret values are encrypted at rest.** Your master password goes through Argon2id (libsodium `crypto_pwhash`, SENSITIVE limits) to unlock an app key. The app key wraps a separate key for each Lens, and each item is encrypted with its own subkey using XChaCha20-Poly1305. All cryptography comes from libsodium.
- **Keys never enter the app's web page.** The app key and every Lens key are held by the app's Rust code, which does all encryption and decryption. The page only handles encrypted data, plus what passes through it by necessity: the master password you type, a secret you're saving, and a secret you reveal or copy. Lock and quitting drop the keys, which are zeroed in memory.
- **Nothing leaves the device.** There are no accounts, no servers, no telemetry and no network calls.
- **The app's page runs under a strict Content Security Policy.** It can load only its own bundled files, and can't fetch from the network or run injected inline scripts. It allows no `eval` and no WebAssembly: all cryptography runs in the app's Rust code.

## What Still does not protect yet

These are known, and being worked on:

- **Lens names, item labels, item types, dates and counts are stored unencrypted.** Only the secret values are encrypted.
- **The vault lives in the app's webview storage** (encrypted, as above), not yet in its own file.
- **Typed and revealed secrets pass through the web page's memory,** which can't be wiped on demand. The Rust side zeroes its own copies.
- **Copied secrets stay on the clipboard.** Clipboard history tools may keep them.
- **There is no auto-lock.**

## Where the vault is stored (macOS)

- **Release builds:** `~/Library/WebKit/com.still.app/`
- **Development builds** (`npm run tauri:dev`): `~/Library/WebKit/still/`. This is a separate, independent vault.
