# Security

Still is a secret manager, so security reports are the most valuable contribution you can make.

## Reporting a vulnerability

Please **do not** open a public issue. Report privately through GitHub: open the repository's **Security** tab and choose **Report a vulnerability**. Include the version or commit you tested, your operating system, and the steps to reproduce.

## Supported versions

Still is pre-1.0. Only the latest commit on `main` gets fixes.

## What Still protects today

- **Secret values are encrypted at rest.** Your master password goes through Argon2id (libsodium `crypto_pwhash`, SENSITIVE limits) to unlock an app key. The app key wraps a separate key for each Lens, and each item is encrypted with its own subkey using XChaCha20-Poly1305. All cryptography comes from libsodium.
- **Keys never enter the app's web page.** The app key and every Lens key are held by the app's Rust code, which does all encryption and decryption. The page only handles encrypted data, plus what passes through it by necessity: the master password you type, a secret you're saving, and a secret you reveal. Lock and quitting drop the keys, which are zeroed in memory.
- **Copied secrets don't linger.** Copying goes straight from Rust to the clipboard, so the page never sees the value. Still asks clipboard-history tools not to record it (the `org.nspasteboard.ConcealedType` marker on macOS; history and cloud exclusion on Windows), and clears it after 30 seconds, when the vault locks and when Still quits, unless you've copied something else since.
- **Auto-lock.** The vault locks after 5 minutes without activity, and as soon as Still sees that the computer slept.
- **The vault is a private file.** It's written so that a crash or power cut leaves the old version or the new one, never a mix; the previous version is kept as a backup; and on macOS and Linux only your user account can read it. Only one copy of Still uses it at a time.
- **Nothing leaves the device.** There are no accounts, no servers, no telemetry and no network calls.
- **The app's page runs under a strict Content Security Policy.** It can load only its own bundled files, and can't fetch from the network or run injected inline scripts. It allows no `eval` and no WebAssembly: all cryptography runs in the app's Rust code.

## What Still does not protect yet

These are known, and being worked on:

- **Lens names, item labels, item types, dates and counts are stored unencrypted.** Only the secret values are encrypted.
- **Typed and revealed secrets pass through the web page's memory,** which can't be wiped on demand. The Rust side zeroes its own copies.
- **Clipboard-history tools may still record copied secrets.** The "don't record" marker is a convention that most, but not all, tools follow. For 30 seconds, any app can read the clipboard.
- **Sleep detection relies on the system's clock behaviour.** It is checked on macOS. Elsewhere the 5-minute idle lock still applies after a sleep.

## Where the vault is stored (macOS)

- **Release builds:** `~/Library/Application Support/com.still.app/vault.json`, with the previous version in `vault.json.bak`.
- **Development builds** (`npm run tauri:dev`): `~/Library/Application Support/com.still.app/dev/vault.json`. This is a separate, independent vault.
- **Older versions** kept the vault in `~/Library/WebKit/com.still.app/` (development: `~/Library/WebKit/still/`). The first version with the vault file copies it into the file once and leaves that old copy as it was.
