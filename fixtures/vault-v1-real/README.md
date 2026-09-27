# Real v1 vault from a release build

A vault created by hand in a release build of the app. It was built from commit `b9c3546` (`tauri build --bundles app`) on macOS, and its data lives at the `tauri://localhost` origin. Everything in it is dummy data, and the password is throwaway.

- `vault.json` holds the five localStorage values. They were exported with Web Inspector from a debug build (same bundle identifier and origin) while it was still at the lock screen, so they were never rewritten. They match, byte for byte, the values the release build wrote to WebKit's localStorage.
- `expected.json` holds the password and the values as they were pasted into the app.

Contents: the Lens `Export Test` holds a password, an API key and a two-line note with non-ASCII text, and the recycle bin holds the forgotten Lens `To Forget` with one password.

**Never regenerate or edit these files.** They are the evidence that real vaults open.
