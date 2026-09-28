# Contributing

Thanks for helping. Still is a vault: a bug can lose or leak someone's secrets. That is why the rules below are strict.

## Get it running

You need:

- **Node.js 24**, the version in `.nvmrc`.
- **Rust.** `rust-toolchain.toml` pins the version, and rustup installs it for you.
- **On Linux,** the [Tauri system dependencies](https://tauri.app/start/prerequisites/).

```bash
npm ci
npm run tauri:dev
```

Development builds keep their own vault, separate from any installed release build (see [SECURITY.md](SECURITY.md)).

## Before you push

```bash
npm run check
```

This runs exactly what CI runs:

- Vitest
- `tsc --noEmit`
- `cargo fmt --check`
- `cargo clippy` (with `-D warnings`)
- `cargo test`

## Rules

- **Existing vaults must keep opening.** Never change these without the maintainer's explicit approval:
  - the bundle `identifier` (`com.still.app`). It names the folder every vault lives in.
  - the dev URL `http://localhost:3000`.
  - the v1 encrypted format: the version byte, the byte layout, and the Argon2id and KDF parameters.

  Tests enforce all three.
- **Never regenerate or edit the fixtures in `fixtures/vault-v1*`** to make a test pass. A failing golden test means existing vaults would break.
- **Write the tests first, then refactor** the code they cover.
- **Tests marked `it.fails` are known bugs.** When you fix one, change it to `it` in the same commit.
- **No custom cryptography.** Use libsodium.
- **No network calls, analytics or remote code at runtime.**
- **Never log secrets.** That includes passwords, keys and decrypted values.
- **Keep commits and pull requests small.** Each should do one thing, and explain what changed and why.

## Releasing

Releases are built by GitHub Actions ([release.yml](.github/workflows/release.yml)), never on a laptop.

1. **Open a release PR** that:
   - runs `npm run set-version -- X.Y.Z`;
   - renames `## [Unreleased]` in `CHANGELOG.md` to `## [X.Y.Z] - YYYY-MM-DD`, starts a new empty `[Unreleased]`, and updates the compare links;
   - updates the README's download and known-issues sections.
2. **Check before merging:** `npm run check-version -- vX.Y.Z` must pass. Then merge.
3. **Tag `main`:** `git tag vX.Y.Z && git push origin vX.Y.Z`.
4. **The workflow does the rest.** It builds the universal macOS app, checks it (both architectures, ad-hoc signature, bundle id `com.still.app`, version), and creates a **draft** release with the disk image, `SHA256SUMS.txt`, and notes from the CHANGELOG.
5. **Test the draft** on an Intel Mac and an Apple Silicon Mac: an existing vault must still open. Then edit the notes and publish.

Never change the bundle id or the dev port in a release: both decide where existing vaults are found.
