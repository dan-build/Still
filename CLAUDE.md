# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project

Still is a local-first encrypted secret manager: a Next.js 15 (App Router, React 18, Tailwind 3) frontend wrapped in a Tauri v2 desktop shell. There are no accounts, no servers, and no telemetry. All crypto runs client-side via libsodium. The product promise is that nothing leaves the device, so don't add network calls, analytics, or remote dependencies at runtime.

## Commands

```bash
npm install
npm run dev            # Next.js dev server on :3000 (browser only)
npm run build          # Static export to ./out
npm run lint           # next lint (no ESLint config is committed yet)
npm run tauri:dev      # Desktop app; runs `npm run dev` itself, loads localhost:3000
npm run tauri:build    # Desktop bundle; runs `npm run build` itself, packages ./out
```

```bash
npm test                     # Vitest, about 1 minute (real Argon2id runs use 1 GiB each)
npx vitest run app/page.persistence.test.tsx     # one file
npx vitest run -t "golden fixture vault-v1-real" # tests whose name matches
npm run check                # what CI will run: check:web (vitest, tsc) + check:rust (fmt, clippy -D warnings, cargo test)
```

Tests sit next to the code (`app/**/*.test.ts(x)`):
- `crypto.golden.test.ts`: opens the committed v1 vaults in `fixtures/vault-v1*` (one generated, one exported from a release build).
- `crypto.vectors.test.ts`: fixed-input byte vectors that any implementation, including the Rust port, must reproduce.
- `crypto.test.ts`: characterisation tests of the current crypto behaviour.
- `page.persistence.test.tsx`: drives the UI in happy-dom with fake crypto and checks localStorage.
- `lib/vault/*.test.ts`: the vault model, format checks and backend. The backend tests also open both golden vaults with the real crypto.

A known bug gets an `it.fails` test first, with a passing sibling that runs the same steps. When you fix it, flip it to `it` in the same commit. Stage 1 left none. Never regenerate or edit the fixtures to make a test pass.

## Architecture

**Static export + Tauri.** [next.config.mjs](next.config.mjs) sets `output: 'export'`, so the app has to stay fully static: no API routes, server actions, or server-only features. Tauri serves `../out` ([src-tauri/tauri.conf.json](src-tauri/tauri.conf.json)). The Rust side ([src-tauri/src/main.rs](src-tauri/src/main.rs)) is a bare window shell with no custom commands. Everything, including persistence, lives in the webview. `console.*` calls are stripped in production builds.

**The UI talks only to the vault backend.** [app/lib/vault/backend.ts](app/lib/vault/backend.ts) defines `VaultBackend`, and `createLocalStorageBackend` implements it on localStorage and `crypto.ts`.
- The backend is the only code that touches stored vault data or keys. The UI gets a key-free `view()` of ids and metadata, and calls the backend for every change and reveal.
- Stage 3b will put a Rust implementation behind the same interface.
- [app/page.tsx](app/page.tsx) holds UI state only: the view, the selected Lens id, modals and toasts.
- [app/lib/vault/model.ts](app/lib/vault/model.ts) holds pure list operations.
- [app/lib/vault/format.ts](app/lib/vault/format.ts) holds v1 shape checks.

Backend rules; the tests depend on them:
- **Every change is written before it becomes visible,** and changes run one at a time.
- **A failed write changes nothing** and throws `VaultWriteError`. Lists that gain a Lens are written first, so a Lens is never missing from both lists.
- **Lenses are kept exactly as stored,** wrapped key included. Unlocking writes nothing, and a Lens whose key can't be unwrapped is kept unchanged but hidden (`view().unreadable`).
- **A stored list that isn't valid JSON blocks unlocking** (`unreadable-data`), because any save would overwrite it.
- **Vault data without its key is `'orphaned'`.** `create()` refuses to run, and the UI shows the recovery screen (`setAside()` copies everything to `still-set-aside-<time>-` keys first).
- **`lock()` zeroes keys and clears the lists,** and every change or write refuses while locked, since writing the cleared lists would wipe the vault.

**Key hierarchy** (all in [app/lib/crypto.ts](app/lib/crypto.ts), using `libsodium-wrappers-sumo`, which is loaded lazily):
1. Master password → Argon2id (`crypto_pwhash`, SENSITIVE limits, 16-byte salt) → a derived key that wraps a random 32-byte **app master key** (`encryptMasterKey` / `decryptMasterKey`).
2. Each Lens has its own random 32-byte **lens key**, wrapped by the app master key (`encryptLensMasterKey`).
3. Each item value is encrypted with a per-item subkey derived from the lens key: `crypto_kdf_derive_from_key` with context `StillSec` and a random uint32 subkey id (`encrypt` / `decrypt`, called only from the backend).

All ciphers are XChaCha20-Poly1305 IETF. Ciphertexts are base64 (ORIGINAL variant) with a leading version byte, currently `1`. Item ciphertexts also store the subkey id as a 4-byte little-endian value after the version byte. Changing any of these formats breaks existing vaults, so bump the version byte and keep the decrypt path for older versions.

**Persistence is `localStorage`.** It uses these keys:
- `still-encrypted-master-key`, `still-salt`, `still-has-pin`: vault setup. When the first two are missing, the app shows `CreatePasswordScreen`, or the recovery screen if any Lens data is left. `still-has-pin` is always written as `"false"`: the PIN never worked and was removed.
- `still-lenses`, `still-recycle-bin`: JSON arrays of lenses. Each lens has its wrapped key in `encryptedMasterKey`, and its items stay encrypted.

localStorage belongs to one origin and one WebKit data folder, so dev and release builds never see each other's vault. On macOS (checked 2026-09-27):
- **Release or bundled build:** origin `tauri://localhost`, data in `~/Library/WebKit/com.still.app/`. The folder comes from `identifier`, so never change `identifier`.
- **`npm run tauri:dev`:** origin `http://localhost:3000`. The binary isn't bundled, so its data lives in `~/Library/WebKit/still/`, named after the executable. Keep the dev port at 3000.

Recycle-bin entries older than 7 days are purged when the vault is unlocked. New ids are 128 random bits in hex. v0.1.0's ids were `Date.now().toString(36)`; they're kept as they are.

## Conventions

- Components are client components (`'use client'`) styled with inline Tailwind classes and hard-coded hex colors (such as `#151515` and `#F8F9FA`) in a minimal, calm look.
- UI tests replace crypto with [app/test/fakeCrypto.ts](app/test/fakeCrypto.ts), which makes real v1 blob shapes and throws libsodium's real error messages. In happy-dom, spy on `localStorage` itself, not `Storage.prototype` (that spy sees nothing), and restore it with `mockRestore()`, because `vi.restoreAllMocks()` doesn't.
- The `@/*` path alias maps to the repo root.
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
- **Reproducible CI builds.** Pin the crate version in `Cargo.lock`, and never enable a feature that fetches "latest" libsodium. On every OS, build from the libsodium source the crate ships with, not from a system library found via pkg-config. The exception is an explicitly pinned `SODIUM_LIB_DIR` that CI sets up the same way on each run. Before stage 3a merges, confirm that `cargo build --offline` works after `cargo fetch`, and check how the crate gets libsodium on Windows MSVC.
- **No network at runtime.** Link libsodium statically into the app binary. The app must not download or load anything at runtime.
- **Only one module uses `unsafe`.** FFI calls live in a single module that exposes safe wrappers. The rest of the crate stays safe code. Wipe keys with `sodium_memzero` or `zeroize`.
- **Tests gate the port.** The golden v1 vault fixture and the JS-generated test vectors must pass before any UI calls into the Rust crypto.