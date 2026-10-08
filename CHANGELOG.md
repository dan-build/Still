# Changelog

All notable changes to Still are recorded here.

The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and versions follow [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Changed

- **The vault's rules now run in the app's Rust code.** Saving, the Archive and its 7-day purge, and the checks that keep unreadable data safe moved out of the web page. The page now sees only the names and labels it shows: no encrypted data, no wrapped keys, and a secret's value only while you reveal it. It can't write to the vault file or ask for any other value to be decrypted. Your vault file and its format are unchanged.

### Fixed

- **Setting old data aside twice within the same millisecond** no longer lets the second copy overwrite the first.

## [0.4.0] - 2026-10-07

### Added

- **Edit a secret.** The pencil on a secret's row changes its label, type or value. The value field starts empty: leave it empty to keep the current secret, so editing a label never puts the secret on screen.
- **Rename a Lens** from the ⋯ menu in its header.
- **Search** with the field at the top of the sidebar, or ⌘F. It finds secrets in every Lens by their labels and Lens names, grouped by Lens, with the usual Reveal, Copy, Edit and Delete. Values stay encrypted and are never searched.

## [0.3.1] - 2026-10-05

### Changed

- **A new app icon** that matches the app: Still's horizon mark on a dark tile, in the Dock, Finder and the app switcher. At the smallest sizes it uses a simpler version of the mark, so it stays clear.

## [0.3.0] - 2026-10-05

### Changed

- **A new design.** Still has its own calm, consistent look, in light and dark: it follows your Mac's appearance setting. It's set in the Geist typeface, bundled with the app, and uses its own set of icons. The accent colour, a quiet indigo, was chosen to stay distinct for people with colour blindness.
- **A sidebar layout.** Your Lenses are listed on the left with their counts, Archive and Lock are at the bottom, and the selected Lens's secrets fill the window. Archive is now a view in the sidebar, showing how many days each forgotten Lens has left.
- **The window's title bar is part of the app,** as in other Mac apps: drag the top strip to move the window, and double-click it to zoom.
- **Deleting a secret, or a Lens in the Archive, now asks first,** because it can't be undone.
- **⌘L locks Still.**
- **Creating a vault tells you about a problem as you type,** such as passwords that don't match, and Return submits it.
- **Copying a secret says which one,** and the message stays while the clipboard's 30 seconds count down.
- **Hidden values always show ten dots,** so a secret's length never shows.

### Fixed

- **Still works fully with the keyboard and screen readers.** Dialogs keep focus inside and give it back when they close, every button has a name, errors are announced, and fields are labelled. When you've turned on Reduce motion, Still keeps its fades but drops movement.

## [0.2.0] - 2026-10-04

### Added

- **Your vault now lives in its own file,** `vault.json` in Still's app data folder (on macOS, `~/Library/Application Support/com.still.app/`). Still moves an existing vault there on first launch, unchanged, and keeps the old copy where it was. Every save is all-or-nothing, so a crash or power cut can't leave a half-saved vault, and the previous version is kept as `vault.json.bak`. Only one copy of Still can use the vault at a time.
- **Copied secrets are cleared from the clipboard after 30 seconds,** and when the vault locks or Still quits, unless you've copied something else since. Copying no longer passes the secret through the app's page, and clipboard-history tools are asked not to record it.
- **Auto-lock.** The vault locks after 5 minutes without activity, and whenever your computer goes to sleep. Still tells you why when it locks itself.

### Changed

- **Don't go back to an older version once this one has opened your vault.** Older versions only see the copy from before the move, so changes made since would seem to vanish. If one does change that old copy, this version says so, and both are kept.
- **Unlocking and creating a vault no longer freeze the window** while the password is checked; the check runs in the background.
- **Still's styles are now built with Tailwind CSS 4.** The app looks the same. Still's window is drawn by your Mac's Safari engine, which must now be **Safari 15.4 or newer**: any Mac on macOS 10.15 or later with Safari updates installed. If Still ever looks unstyled, update Safari.
- **Still's interface is now built with Vite instead of Next.js.** Nothing changes for you: the app looks and works the same, and opens your existing vault.

### Security

- **Encryption keys never enter the app's web page.** All encryption and decryption now happens in Still's Rust code, which holds the keys while the vault is unlocked and wipes them when you lock or quit. The page only sees encrypted data, plus the password you type and the secrets you save or reveal.
- **The app's page no longer contains any cryptography code,** and its security policy allows no `eval` or WebAssembly at all.
- **A build tool with an unfixed security advisory is gone.** Tailwind CSS 3 depended on `braces` (GHSA-vfj7-8cjw-p6xm, no fixed release); Tailwind CSS 4 doesn't. It was only used while building and never shipped in the app.
- **The app now runs under a strict Content Security Policy.** Its page can load only Still's own files, so injected scripts or remote content can't run or phone home.

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

[Unreleased]: https://github.com/dan-build/Still/compare/v0.4.0...HEAD
[0.4.0]: https://github.com/dan-build/Still/compare/v0.3.1...v0.4.0
[0.3.1]: https://github.com/dan-build/Still/compare/v0.3.0...v0.3.1
[0.3.0]: https://github.com/dan-build/Still/compare/v0.2.0...v0.3.0
[0.2.0]: https://github.com/dan-build/Still/compare/v0.1.1...v0.2.0
[0.1.1]: https://github.com/dan-build/Still/compare/v0.1.0...v0.1.1
[0.1.0]: https://github.com/dan-build/Still/releases/tag/v0.1.0
