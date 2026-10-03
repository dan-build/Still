# Still

**An offline password and secret manager for your Mac, for people who want their passwords, API keys and private notes kept on their own computer instead of in someone's cloud.**

No account, no sync, no telemetry. Still never connects to the internet.

> **Early pre-release (v0.1.1).** The data-loss issues found in v0.1.0 are fixed, but Still is young. Don't make it the only place you keep anything you can't afford to lose, and read [Known issues](#known-issues).

![Still showing a Lens with three secrets](docs/screenshot.png)

## Features

- **One master password.** It unlocks everything. The key is derived with Argon2id at libsodium's highest-cost ("sensitive") setting, which makes guessing the password slow and expensive.
- **Lenses.** Separate collections for different parts of your life, such as work, personal or banking. Each Lens has its own encryption key.
- **Three kinds of secret:** passwords, API keys or tokens, and multi-line secure notes. Reveal a secret, copy it, or delete it.
- **A 7-day recycle bin.** A Lens you forget moves to the Archive for 7 days, where you can restore it or delete it for good.
- **Lock.** One click returns Still to the password screen and clears its keys from the app's memory.
- **Offline by design.** No servers, no accounts and no analytics. Your vault lives only on your Mac.
- **Open source** under the MIT licence. Read the code, or build it yourself instead of trusting a download.

Not there yet: editing a saved secret, renaming a Lens, and search.

## What's encrypted

Still uses [libsodium](https://doc.libsodium.org/), a widely used and audited crypto library. It doesn't implement any cryptography of its own.

**Encrypted:** every secret value, meaning the password, key or note itself.
- Your master password unlocks an app key using Argon2id.
- The app key unlocks a separate key for each Lens.
- Each secret is encrypted with its own key derived from that Lens key, using XChaCha20-Poly1305.

**Not encrypted yet:**
- Lens names
- secret labels (such as "Bank login")
- secret types
- dates and item counts

Anyone who can read your Mac's files can see those, but not the secret values.

[SECURITY.md](SECURITY.md) lists the other current limits and explains how to report a vulnerability privately.

## Known issues

**Fixed in v0.1.1:**
- forgetting your only Lens, and changes to the last item in the Archive, weren't saved;
- a Lens that couldn't be read could be erased;
- spaces at the start or end of a secret were removed.

The PIN, which never worked, is gone. The [CHANGELOG](CHANGELOG.md) has the full list.

**If you used v0.1.0:** it removed spaces and line breaks at the start or end of a secret before saving. Still can't detect or restore those characters. If a saved secret doesn't work and the real one starts or ends with a space or line break, delete it and add it again.

Still open in **v0.1.1**:

- **Unlocking freezes the window for a few seconds.** The password hashing runs where the app draws its window. This goes away with the move to Rust (see the [Roadmap](#roadmap)).
- **Lens names, labels, types and dates aren't encrypted yet.** See [What's encrypted](#whats-encrypted).
- **Copied secrets stay on the clipboard** until you copy something else, and **Still doesn't lock itself** after a period of inactivity.

## Download and install

Still is a macOS app. The current release, v0.1.1, is a pre-release. It's a universal build that runs natively on both Intel and Apple Silicon Macs.

1. From the [Releases page](https://github.com/dan-build/Still/releases), download the `.dmg` and `SHA256SUMS.txt`.
2. Optional but recommended: check the download. In Terminal, run `cd ~/Downloads && shasum -a 256 -c SHA256SUMS.txt`. It should print the `.dmg`'s name followed by `OK`.
3. Open the `.dmg` and drag **Still** into your **Applications** folder.
4. The app isn't signed with an Apple Developer ID yet, so macOS blocks it the first time you open it. Go to **System Settings → Privacy & Security**, scroll down, and click **Open Anyway** next to the message about Still.

Vaults from v0.1.0 open in v0.1.1 as they are; there's nothing to migrate.

Your vault is stored in `~/Library/WebKit/com.still.app/`. Deleting that folder deletes your vault.

There are no Windows or Linux downloads yet. Still's tests pass on both, but it hasn't been tested there as an installed app.

## Build from source

<details>
<summary>Build Still yourself instead of using the download</summary>

You need:

- **Node.js 24.** The version is in `.nvmrc`.
- **Rust**, installed through [rustup](https://rustup.rs/). `rust-toolchain.toml` pins the version, and rustup installs it for you.
- **The [Tauri prerequisites](https://tauri.app/start/prerequisites/)** for your system.

```bash
git clone https://github.com/dan-build/Still.git
cd Still
npm ci
npm run tauri:dev     # run in development
npm run tauri:build   # build the app into target/release/bundle/
npm run check         # run everything CI runs: tests, type check, Rust formatting, lints and tests
```

Development builds keep their own separate vault, so they never touch your real one.

</details>

## Roadmap

1. ~~**v0.1.1: fix the data-loss issues**~~ Done in v0.1.1, together with the first universal macOS build, built in GitHub Actions from the public source.
2. **Move encryption and key handling into Rust.** Done on `main`, for the next release: keys stay out of the app's web view, and unlocking no longer freezes the window. Next: clipboard clearing and auto-lock.
3. **Store the vault in its own file** instead of the web view's storage. Existing vaults will move across automatically on first launch.
4. **Encrypt Lens names and labels as well.** Older vaults will keep opening.
5. **Signed and notarised releases,** so macOS opens Still without the "Open Anyway" step.

Each step keeps existing vaults working. Tests that must open real vaults made by earlier versions check this.

## Contributing and security

- [CONTRIBUTING.md](CONTRIBUTING.md) covers how to build, test and send changes.
- [SECURITY.md](SECURITY.md) explains what Still protects, and how to report a vulnerability privately. Please don't use public issues for security reports.

## Licence

MIT. See [LICENSE](LICENSE).
