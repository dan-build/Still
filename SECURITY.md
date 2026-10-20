# Security

Still is a secret manager, so security reports are the most valuable contribution you can make.

## Reporting a vulnerability

Please **do not** open a public issue. Report privately through GitHub: open the repository's **Security** tab and choose **Report a vulnerability**. Include the version or commit you tested, your operating system, and the steps to reproduce.

## Supported versions

Still is pre-1.0. Only the latest release is supported: fixes go into the next release.

## What Still protects today

- **The whole vault is encrypted at rest** (format v2, [docs/vault-format-v2.md](docs/vault-format-v2.md)). Your master password goes through Argon2id (libsodium `crypto_pwhash`, at least the SENSITIVE limits, recorded in the file) to unlock an app key. The app key wraps a separate key for each Lens, and each item is encrypted with its own subkey using XChaCha20-Poly1305. Lens names, labels, types, dates and counts are encrypted too, with the items, as one body padded to 4 KiB. All cryptography comes from libsodium.
- **Any change to the vault file is detected.** Every part is bound to the rest with authenticated data: a swapped, edited or spliced value, an older copy of part of the vault, or weaker Argon2id settings make it fail to open as damaged data, and nothing is changed or deleted because of it.
- **Keys and encrypted data never enter the app's web page.** The app's Rust code holds the app key and every Lens key, does all encryption and decryption, and alone reads and writes the vault file. The page sees Lens names, secret labels and ids, plus what passes through it by necessity: the master password you type, a secret you're saving, and a secret you reveal. It names a secret by its id, so it can't ask Rust to decrypt anything else, and it can't write vault data. Lock and quitting drop the keys, which are zeroed in memory.
- **Copied secrets don't linger.** Copying goes straight from Rust to the clipboard, so the page never sees the value. Still asks clipboard-history tools not to record it (the `org.nspasteboard.ConcealedType` marker on macOS; history and cloud exclusion on Windows), and clears it after 30 seconds, when the vault locks and when Still quits, unless you've copied something else since.
- **Auto-lock.** The vault locks after 5 minutes without activity, and as soon as Still sees that the computer slept.
- **The vault is a private file.** It's written so that a crash or power cut leaves the old version or the new one, never a mix; the previous version is kept as a backup; and on macOS and Linux only your user account can read it. Only one copy of Still uses it at a time.
- **Nothing leaves the device.** There are no accounts, no servers, no telemetry and no network calls.
- **The app's page runs under a strict Content Security Policy.** It can load only its own bundled files, and can't fetch from the network or run injected inline scripts. It allows no `eval` and no WebAssembly: all cryptography runs in the app's Rust code.

## What Still does not protect yet

These are known, and being worked on:

- **An attacker who can write your files can make the right password look wrong.** A changed salt, setting or wrapped key fails the same check as a wrong password, and nothing can tell them apart. That denies access but reveals nothing. Still never suggests anything destructive (a new vault, setting data aside) because a password didn't work: if the right one is refused, keep your files and check them.
- **Rolling back the whole file isn't detected.** A complete older copy of `vault.json` (from a backup, say) opens as it is. Detecting that would need state outside the file, which a local-only app doesn't have.
- **Older copies in the old format.** Upgrading keeps the previous file as `vault-v1.json`, where Lens names, secret labels, types and dates are readable (secret values stay encrypted), and v1 files can't detect changes. Vaults that started in v0.1.x also keep their old copy in WebKit's storage, with the same readable metadata. Still never deletes either copy. After the upgrade, Still remembers it (in the app's local storage) and asks before opening a v1 file in the vault's place, so a changed old copy can't quietly stand in. Someone with full access to your account can remove that note.
- **Typed and revealed secrets pass through the web page's memory,** which can't be wiped on demand. The Rust side zeroes its own copies.
- **Clipboard-history tools may still record copied secrets.** The "don't record" marker is a convention that most, but not all, tools follow. For 30 seconds, any app can read the clipboard.
- **Sleep detection relies on the system's clock behaviour.** It is checked on macOS. Elsewhere the 5-minute idle lock still applies after a sleep.

## Where the vault is stored (macOS)

- **Release builds:** `~/Library/Application Support/com.still.app/vault.json`, with the previous version in `vault.json.bak`. After the upgrade to format v2, the file from before is kept as `vault-v1.json` (Still never changes or deletes it).
- **Development builds** (`npm run tauri:dev`): `~/Library/Application Support/com.still.app/dev/vault.json`. This is a separate, independent vault.
- **Older versions** kept the vault in `~/Library/WebKit/com.still.app/` (development: `~/Library/WebKit/still/`). The first version with the vault file copies it into the file once and leaves that old copy as it was.
