# Real v2 vault from a release build

The vault in `fixtures/vault-v1-real`, as the release builds have kept it since: moved into the vault file by v0.2.0, converted to format v2 by v0.6.0 on its first unlock, and last written by the v0.10.0 release build (`tauri build --bundles app`, commit `6e25654`) on macOS, on 2026-11-08. Everything in it is dummy data, and the password is throwaway.

- `vault.json` is the v2 file exactly as it was on disk, copied from the app-data folder while Still was closed.
- `expected.json` holds the password, and each secret's label, type and value as entered in the app. The values were read back from this file before it was committed.

Contents: the Lens `Export Test` holds the v1 vault's three secrets (a password, an API key and a two-line note with non-ASCII text) and four passwords added by later builds during manual checks, one of them made by the password generator. The Archive is empty: the v1 vault's `To Forget` was purged after its 7 days.

`crates/still-core/tests/golden_v2.rs` opens it and reveals every secret; `src-tauri/src/vault.rs` unlocks it through the vault file, changes it and opens it again.

**Never regenerate or edit these files.** They are the evidence that real v2 vaults open.
