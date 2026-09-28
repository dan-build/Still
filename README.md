# Still

**An offline password and secret manager for your Mac, for people who want their passwords, API keys and private notes kept on their own computer instead of in someone's cloud.**

No account, no sync, no telemetry. Still never connects to the internet.

> **Early pre-release (v0.1.0).** It works, but has known issues that can lose data in specific cases. Read [Known issues](#known-issues) before storing anything you can't afford to lose.

<!-- Screenshot: save it as docs/screenshot.png, then uncomment the next line.
![Still showing a Lens with three secrets](docs/screenshot.png)
-->

## Features

- **One master password.** It unlocks everything. The key is derived with Argon2id at libsodium's highest-cost ("sensitive") setting, which makes guessing the password slow and expensive.
- **Lenses.** Separate collections for different parts of your life, such as work, personal or banking. Each Lens has its own encryption key.
- **Three kinds of secret:** passwords, API keys or tokens, and multi-line secure notes. Reveal a secret, copy it, or delete it.
- **A 7-day recycle bin.** A Lens you forget moves to the Archive for 7 days, where you can restore it or delete it for good.
- **Lock.** One click returns Still to the password screen.
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

These affect **v0.1.0**, the current release. Fixes are planned for **v0.1.1**.

- **Forgetting your only Lens isn't saved.** After you restart, it shows up both in your Lenses and in the Archive. Keep at least one other Lens until the fix ships.
- **Changes to the last item in the Archive aren't saved.** If "Delete forever" or "Restore" acts on the only Lens in the Archive, or the 7-day clean-up empties it, the Lens comes back after a restart. A Lens you've deleted forever may still be on disk.
- **Spaces and line breaks at the start or end of a secret are removed** when you save it. A password that really ends in a space will be stored without it.
- **The optional PIN does nothing.** Setting a PIN has no effect, and "Use PIN instead" on the unlock screen can never unlock. Use your master password. In PIN mode, the field also shows what you type as plain text.
- **A master password made only of spaces** is accepted when you create the vault, but can't be entered afterwards.
- **In rare cases a Lens can disappear.** This can happen if the saved data is damaged, or if part of the vault goes missing. Still hides an unreadable Lens without warning, and the next change you make erases it.
- **Unlocking freezes the window for a few seconds.** Every failure shows as "Incorrect password or PIN", even when the real problem is something else, such as damaged data.

## Download and install

Still is a macOS app. The current release is a pre-release.

1. Download `Still-0.1.0.dmg` from the [Releases page](https://github.com/dan-build/Still/releases).
2. Optional but recommended: check the download. In Terminal, run `shasum -a 256 ~/Downloads/Still-0.1.0.dmg`. It should print:
   `1ae0e529676abf693350aa85be51c6307e06a88de121a9853bf1155e90453827`
3. Open the `.dmg` and drag **Still** into your **Applications** folder.
4. The app isn't signed or notarised yet, so macOS blocks it the first time you open it. Go to **System Settings → Privacy & Security**, scroll down, and click **Open Anyway** next to the message about Still.

The v0.1.0 build is for Intel Macs. On Apple Silicon Macs it runs through Rosetta 2, which macOS offers to install if needed.

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

1. **v0.1.1: fix the data-loss issues** listed above. It will also be the first universal macOS build, running natively on both Intel and Apple Silicon Macs, and built in GitHub Actions from the public source.
2. **Move encryption and key handling into Rust.** Keys will stay out of the app's web view. This also brings clipboard clearing and auto-lock.
3. **Store the vault in its own file** instead of the web view's storage. Existing vaults will move across automatically on first launch.
4. **Encrypt Lens names and labels as well.** Older vaults will keep opening.
5. **Signed and notarised releases,** so macOS opens Still without the "Open Anyway" step.

Each step keeps existing vaults working. Tests that must open real vaults made by earlier versions check this.

## Contributing and security

- [CONTRIBUTING.md](CONTRIBUTING.md) covers how to build, test and send changes.
- [SECURITY.md](SECURITY.md) explains what Still protects, and how to report a vulnerability privately. Please don't use public issues for security reports.

## Licence

MIT. See [LICENSE](LICENSE).
