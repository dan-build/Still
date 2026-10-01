# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project

Still is a local-first encrypted secret manager: a Vite + React 18 + Tailwind 3 frontend wrapped in a Tauri v2 desktop shell. There are no accounts, no servers, and no telemetry. All crypto runs client-side via libsodium. The product promise is that nothing leaves the device, so don't add network calls, analytics, or remote dependencies at runtime.

## Commands

```bash
npm install
npm run dev            # Vite dev server on :3000 (browser only)
npm run build          # Production build to ./dist
npm run tauri:dev      # Desktop app; runs `npm run dev` itself, loads localhost:3000
npm run tauri:build    # Desktop bundle; runs `npm run build` itself, packages ./dist
```

```bash
npm test                     # Vitest, about 1 minute (real Argon2id runs use 1 GiB each)
npx vitest run src/app/App.persistence.test.tsx  # one file
npx vitest run -t "golden fixture vault-v1-real" # tests whose name matches
npm run check                # what CI will run: check:web (vitest, tsc -b, vite build) + check:rust (fmt, clippy -D warnings, cargo test)
```

Tests sit next to the code (`src/**/*.test.ts(x)`):
- `platform/crypto/crypto.golden.test.ts`: opens the committed v1 vaults in `fixtures/vault-v1*` (one generated, one exported from a release build).
- `crypto.vectors.test.ts`: fixed-input byte vectors that any implementation, including the Rust port, must reproduce.
- `crypto.test.ts`: characterisation tests of the current crypto behaviour.
- `app/App.persistence.test.tsx`: drives the UI in happy-dom with fake crypto and checks localStorage.
- `features/vault/model/*.test.ts` and `platform/storage/backend.test.ts`: the vault model, format checks and backend. The backend tests also open both golden vaults with the real crypto.

A known bug gets an `it.fails` test first, with a passing sibling that runs the same steps. When you fix it, flip it to `it` in the same commit. Stage 1 left none. Never regenerate or edit the fixtures to make a test pass.

## Architecture

**Vite + Tauri.** [vite.config.ts](vite.config.ts) builds [index.html](index.html) and `src/` into `dist/`, which Tauri bundles ([src-tauri/tauri.conf.json](src-tauri/tauri.conf.json)). The app is fully static. The Rust side ([src-tauri/src/lib.rs](src-tauri/src/lib.rs)) is a bare window shell with no custom commands. Everything, including persistence, lives in the webview. `console.*` calls are stripped in production builds. Vitest settings live in `vite.config.ts` too.

**Layout** (`@/` is `src/`):
- `src/app/`: the shell (`main.tsx`, `App.tsx`, styles); `lock/` holds the unlock, create-password and recovery screens.
- `src/features/<feature>/{model,ui}`: `vault/model` (the pure vault model), `lenses/ui`, `recycle-bin/ui`.
- `src/platform/`: `storage/` (the backend) and `crypto/` (libsodium). Only platform code touches storage or crypto.
- `src/test/`: test helpers.

**CSP.** `tauri.conf.json` sets a strict `csp`: only the app's own files, Tauri's IPC and `'unsafe-eval'` for libsodium's embedded wasm. `'wasm-unsafe-eval'` is not enough: WebKit before Safari 16 (macOS 12) ignores it, blocks the wasm and unlocking fails. Stage 3b removes the wasm and `'unsafe-eval'` with it. On desktop, `devCsp` is not applied in `tauri dev` (the page loads straight from Vite), so check CSP changes in a `tauri build --debug` bundle, which has the Web Inspector. Inspector console input is exempt from the CSP, so test by injecting a script element rather than calling `eval`. `freezePrototype` is on. Rust tests in `src-tauri/src/lib.rs` allow-list every source, so never add a remote origin. TypeScript is split into `tsconfig.app.json` (no tests, no Node types), `tsconfig.test.json` and `tsconfig.node.json`, all with `noUnusedLocals`/`noUnusedParameters`.

**The UI talks only to the vault backend.** [src/platform/storage/backend.ts](src/platform/storage/backend.ts) defines `VaultBackend`, and `createLocalStorageBackend` implements it on localStorage and `crypto.ts`.
- The backend is the only code that touches stored vault data or keys. The UI gets a key-free `view()` of ids and metadata, and calls the backend for every change and reveal.
- Stage 3b will put a Rust implementation behind the same interface.
- [src/app/App.tsx](src/app/App.tsx) holds UI state only: the view, the selected Lens id, modals and toasts.
- [src/features/vault/model/model.ts](src/features/vault/model/model.ts) holds pure list operations.
- [src/features/vault/model/format.ts](src/features/vault/model/format.ts) holds v1 shape checks.

Backend rules; the tests depend on them:
- **Every change is written before it becomes visible,** and changes run one at a time.
- **A failed write changes nothing** and throws `VaultWriteError`. Lists that gain a Lens are written first, so a Lens is never missing from both lists.
- **Lenses are kept exactly as stored,** wrapped key included. Unlocking writes nothing, and a Lens whose key can't be unwrapped is kept unchanged but hidden (`view().unreadable`).
- **A stored list that isn't valid JSON blocks unlocking** (`unreadable-data`), because any save would overwrite it.
- **Vault data without its key is `'orphaned'`.** `create()` refuses to run, and the UI shows the recovery screen (`setAside()` copies everything to `still-set-aside-<time>-` keys first).
- **`lock()` zeroes keys and clears the lists,** and every change or write refuses while locked, since writing the cleared lists would wipe the vault.

**Key hierarchy** (all in [src/platform/crypto/crypto.ts](src/platform/crypto/crypto.ts), using `libsodium-wrappers-sumo`, which is loaded lazily):
1. Master password → Argon2id (`crypto_pwhash`, SENSITIVE limits, 16-byte salt) → a derived key that wraps a random 32-byte **app master key** (`encryptMasterKey` / `decryptMasterKey`).
2. Each Lens has its own random 32-byte **lens key**, wrapped by the app master key (`encryptLensMasterKey`).
3. Each item value is encrypted with a per-item subkey derived from the lens key: `crypto_kdf_derive_from_key` with context `StillSec` and a random uint32 subkey id (`encrypt` / `decrypt`, called only from the backend).

All ciphers are XChaCha20-Poly1305 IETF. Ciphertexts are base64 (ORIGINAL variant) with a leading version byte, currently `1`. Item ciphertexts also store the subkey id as a 4-byte little-endian value after the version byte. Changing any of these formats breaks existing vaults, so bump the version byte and keep the decrypt path for older versions.

**Persistence is `localStorage`.** It uses these keys:
- `still-encrypted-master-key`, `still-salt`, `still-has-pin`: vault setup. When the first two are missing, the app shows `CreatePasswordScreen`, or the recovery screen if any Lens data is left. `still-has-pin` is always written as `"false"`: the PIN never worked and was removed.
- `still-lenses`, `still-recycle-bin`: JSON arrays of lenses. Each lens has its wrapped key in `encryptedMasterKey`, and its items stay encrypted.

localStorage belongs to one origin and one WebKit data folder, so dev and release builds never see each other's vault. On macOS (checked 2026-09-27):
- **Release or bundled build:** origin `tauri://localhost`, data in `~/Library/WebKit/com.still.app/`. The folder comes from `identifier`, so never change `identifier`.
- **`npm run tauri:dev`:** origin `http://localhost:3000`. The binary isn't bundled, so its data lives in `~/Library/WebKit/still/`, named after the executable. Keep the dev port at 3000; Vite uses `strictPort`, and tests pin both the port and `identifier`.

Recycle-bin entries older than 7 days are purged when the vault is unlocked. New ids are 128 random bits in hex. v0.1.0's ids were `Date.now().toString(36)`; they're kept as they are.

**Rust crypto core (stage 3a; not used by the app until stage 3b).** [crates/still-core](crates/still-core) implements the v1 format byte for byte like `crypto.ts`, on libsodium 1.0.22, the same release as the JS side.
- `sodium.rs` is the only `unsafe` code.
- `format.rs` parses and writes blobs and never panics.
- `crypto.rs` holds the operations and the `Key` type, which is zeroed on drop and prints as `Key(redacted)`.
- `error.rs`: `WrongKey`, `Corrupt`, `PasswordHashFailed`, `EmptyPlaintext`, `NotUtf8`.

Differences from `crypto.ts`, on purpose:
- Every decrypt checks the version byte, including the master key's.
- Damaged master-key data is `Corrupt` before any Argon2id run.
- Blank values are refused using JavaScript's definition of whitespace.

Other notes:
- `tests/golden_v1.rs` and `tests/vectors_v1.rs` must always pass.
- libsodium is always built at `opt-level = 3` (root `Cargo.toml`), or Argon2id tests take minutes.
- Building needs a C compiler (Xcode Command Line Tools on macOS, build-essential on Linux). Run `cargo test -p still-core` for this crate alone.

## Conventions

- Components are styled with inline Tailwind classes and hard-coded hex colors (such as `#151515` and `#F8F9FA`) in a minimal, calm look.
- UI tests replace crypto with [src/test/fakeCrypto.ts](src/test/fakeCrypto.ts), which makes real v1 blob shapes and throws libsodium's real error messages. In happy-dom, spy on `localStorage` itself, not `Storage.prototype` (that spy sees nothing), and restore it with `mockRestore()`, because `vi.restoreAllMocks()` doesn't.
- The `@/*` path alias maps to `src/`. Use it for imports across folders; keep imports within a folder relative.
- Domain terms: a **Lens** is an encrypted collection. An **Item** is a `password`, `key`, or `note` stored in a Lens. The UI calls the recycle bin "Archive", and deleting a Lens is called "forget".

## Owner's goals

### Direction
Restructure Still into a polished, professional Tauri desktop app. Still
stays a local-first secret manager.
- Replace Next.js static export with Vite + React + TypeScript. Next.js adds
  nothing for a desktop app that must stay fully static.
- Move encryption, key handling and storage into Rust, exposed to the UI
  through Tauri commands. TypeScript and React handle the UI only. Secrets
  should never live in the webview longer than needed.
- Store the vault in an app data file via Rust instead of localStorage.
- Add tests: Rust unit tests for crypto and storage, Vitest for the UI.
- Professional repo hygiene: SECURITY.md (important for a vault),
  CHANGELOG.md, CONTRIBUTING.md, and GitHub Actions that build releases.
- Keep the webview UI; a native Rust GUI is low priority and not needed.

### Priorities, in order
1. Security and correctness. This is a vault; a bug can lose or leak secrets.
2. Architecture: the moves above.
3. Design and UX polish.

### Hard rules
- Existing vaults must keep working. Any change to storage or the encrypted
  format needs a migration path and a test using a real old vault. Never
  change the format without my explicit approval. The version byte and the
  old decrypt path must stay.
- Use well-known, audited crates for cryptography. Never write custom crypto.
- No network calls, analytics or remote dependencies at runtime.
- Secrets must never be logged, printed or kept in memory longer than needed.
- Plan before any multi-file change, and wait for approval.
- Add tests before refactoring the code they cover. Commit in small steps.

### Decisions

**Rust crypto uses `libsodium-sys-stable`** (decided 2026-09-27). Being byte-for-byte compatible with existing vaults matters more than being pure Rust. Linking the same audited libsodium that the JS app uses today reproduces `crypto_pwhash`, XChaCha20-Poly1305 IETF and `crypto_kdf_derive_from_key` exactly. We rejected the RustCrypto `argon2` and `blake2` crates, because they are partly unaudited and would need to be proven equivalent. Requirements:
- **Reproducible, offline builds (done in stage 3a).** The crate is pinned to `=1.24.0`, with no `fetch-latest` or pkg-config. It can't build from source on Windows MSVC and would download a prebuilt zip that changes in place upstream. So both signed archives live in [vendor/libsodium](vendor/libsodium/README.md), and `.cargo/config.toml` sets `SODIUM_DIST_DIR` to that folder. The build script still checks each archive against libsodium's pinned minisign key. CI rebuilds libsodium with `cargo build --offline --locked` on every OS. To update libsodium, follow vendor/libsodium/README.md.
- **No network at runtime.** Link libsodium statically into the app binary. The app must not download or load anything at runtime.
- **Only one module uses `unsafe`:** `crates/still-core/src/sodium.rs`, behind `#![deny(unsafe_code)]`. Keys are wiped with `sodium_memzero`; no zeroize or secrecy crates.
- **Tests gate the port.** The golden v1 vault fixture and the JS-generated test vectors must pass before any UI calls into the Rust crypto. They pass in `crates/still-core/tests/` on all three OSes.