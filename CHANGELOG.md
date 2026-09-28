# Changelog

All notable changes to Still are recorded here.

The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and versions follow [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [0.1.1] - 2026-09-28

### Fixed

- **Forgetting your only Lens is now saved.** Before, it came back after a restart, both in your Lenses and in the Archive.
- **"Delete forever" and "Restore" on the last Lens in the Archive are now saved,** and so is the 7-day clean-up when it empties the Archive. Before, those Lenses came back after a restart, and deleted data stayed on disk.
- **Lenses that v0.1.0 left in both the list and the Archive** (because of the bug above) are no longer duplicated when you restore or forget them.
- **A Lens that can't be opened is no longer erased.** Before, it was hidden without warning and deleted by your next change. Now it's kept exactly as stored, and Still tells you: "1 Lens couldn't be opened. It's kept safe and unchanged."
- **Still no longer creates a new vault on top of existing Lenses** when the key that opens them is missing. It shows a recovery screen instead. From there you can restore a backup, or set the old data aside (nothing is deleted) and start a new vault.
- **Secrets are stored exactly as typed.** Spaces and line breaks at the start or end of a secret were removed before saving. When a secret starts or ends with them, Still now says so and offers to remove them.
- **A master password made only of spaces now unlocks its vault.** New vaults no longer accept one.
- **A change that can't be saved** (for example, because storage is full) now shows an error instead of looking saved. Nothing is lost when a save fails partway.
- **Revealed secrets keep their spaces and line breaks on screen,** so multi-line notes show as written.
- **Unlock errors now say what happened:** a wrong password, vault data that can't be read, or another failure such as running out of memory. Before, every failure showed "Incorrect password or PIN".

### Changed

- **One download for every Mac.** The macOS app is now a universal build that runs natively on Intel and Apple Silicon. v0.1.0 was Intel-only and ran through Rosetta on Apple Silicon.
- **The app is ad-hoc signed.** It still isn't signed with an Apple Developer ID, so macOS asks you to allow it once.
- **Lock now clears the app's keys from its own memory** and closes the open Lens, instead of only hiding the screen.
- **Secret fields turn off spellcheck and autocorrect.**
- **New Lenses and secrets get random ids.** The old ones were based on the creation time, so two could clash. Existing ids are unchanged.

### Removed

- **The optional PIN.** It was never implemented: setting one had no effect, and "Use PIN instead" could never unlock. Vaults created with a PIN still open with their master password.

### Notes

- **Secrets saved by v0.1.0 lost any spaces or line breaks at the start or end.** Still can't detect or restore those characters, because they were never stored. If a saved secret doesn't work and the real one starts or ends with a space or line break, delete it and add it again.
- **Your vault's format is unchanged.** Vaults from v0.1.0 open as before, and v0.1.0 can still open a vault saved by this version.

## [0.1.0] - 2026-06-12

First public pre-release, for macOS.

### Added

- A master password, derived with Argon2id, protecting an app key.
- Lenses, each with its own encryption key, holding passwords, API keys or tokens, and secure notes, encrypted with XChaCha20-Poly1305 via libsodium.
- An Archive (recycle bin) that keeps forgotten Lenses for 7 days.
- Offline by design: no accounts, servers or telemetry.

[Unreleased]: https://github.com/dan-build/Still/compare/v0.1.1...HEAD
[0.1.1]: https://github.com/dan-build/Still/compare/v0.1.0...v0.1.1
[0.1.0]: https://github.com/dan-build/Still/releases/tag/v0.1.0
