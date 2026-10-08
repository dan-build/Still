# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project

Still is a local-first encrypted secret manager: a Vite + React 18 + Tailwind 4 frontend wrapped in a Tauri v2 desktop shell. There are no accounts, no servers, and no telemetry. All crypto runs on the device, in Rust, via libsodium. The product promise is that nothing leaves the device, so don't add network calls, analytics, or remote dependencies at runtime.

## Commands

```bash
npm install
npm run dev            # Vite dev server on :3000 (browser only; can't unlock, the crypto is in Rust)
npm run build          # Production build to ./dist
npm run tauri:dev      # Desktop app; runs `npm run dev` itself, loads localhost:3000
npm run tauri:build    # Desktop bundle; runs `npm run build` itself, packages ./dist
```

```bash
npm test                     # Vitest, about 1 minute (real Argon2id runs use 1 GiB each)
npx vitest run src/app/App.test.tsx  # one file
npx vitest run -t "golden fixture vault-v1-real" # tests whose name matches
npm run lint                 # ESLint: TypeScript, rules of hooks, jsx-a11y (strict); no warnings allowed
npm run check                # what CI will run: check:web (vitest, lint, tsc -b, vite build) + check:rust (fmt, clippy -D warnings, cargo test)
```

Tests sit next to the code (`src/**/*.test.ts(x)`):
- `test/reference/`: `crypto.ts`, the JS v1 implementation that v0.1.x shipped, kept as the reference. Its tests open the committed vaults in `fixtures/vault-v1*` (`vault-v1` generated, `vault-v1-real` exported from a release build, `vault-v1-rust` written by the Rust session), check the fixed-input vectors that every implementation must reproduce, and characterise its behaviour. `libsodiumVaultCrypto.ts` is the JS `VaultCrypto` the tests use.
- `app/App.test.tsx`: drives the UI in happy-dom against `src/test/fakeVaultApi.ts`, an in-memory stand-in for the vault commands, and checks what the UI asks of them and shows. `app/StillApp.test.tsx` covers the start-up screens.
- `platform/tauri/vaultApi.test.ts`: the vault commands' names, arguments and error codes, with `invoke` mocked.
- Rust: `crates/still-core/tests/`: golden vaults, vectors and the session; `behaviour_v1.rs` replays `fixtures/vault-behaviour-v1` (what the TypeScript backend did, step by step) against the Rust backend; `backend_v1.rs` opens every golden vault through the backend. `src-tauri/src/`: the vault file, the commands' state, config and capability guards.

A known bug gets an `it.fails` test (or, in Rust, a test of the right behaviour that fails) first, with a passing sibling that runs the same steps. When you fix it, flip it in the same commit. None are open. Never regenerate or edit the fixtures to make a test pass.

## Architecture

**Vite + Tauri.** [vite.config.ts](vite.config.ts) builds [index.html](index.html) and `src/` into `dist/`, which Tauri bundles ([src-tauri/tauri.conf.json](src-tauri/tauri.conf.json)). The app is fully static. The Rust side ([src-tauri/src/lib.rs](src-tauri/src/lib.rs)) runs the vault backend (every rule about stored vault data), holds the unlocked vault's keys, does all the crypto, copies to the clipboard, runs auto-lock and keeps the vault file, behind eighteen commands. `console.*` calls are stripped in production builds. Vitest settings live in `vite.config.ts` too.

**Layout** (`@/` is `src/`):
- `src/app/`: the shell (`main.tsx`, `App.tsx`, styles); `lock/` holds the unlock, create-password and recovery screens.
- `src/features/<feature>/{model,ui}`: `vault/model/types.ts` (the vault as the page sees it), `lenses/{model,ui}`, `recycle-bin/ui`.
- `src/shared/ui/`: the shared UI pieces. `Icon.tsx` holds Still's own icon set (16px grid, 1.5px stroke; no icon library) and the `Mark`.
- `src/platform/`: `tauri/` (the only code that calls `invoke`: the vault commands, the vault file at start-up, auto-lock) and `storage/startup.ts` (the one-time move from localStorage).
- `src/test/`: test helpers, and `reference/` (the JS crypto, for tests only; never imported by the app).

**CSP.** `tauri.conf.json` sets a strict `csp`: only the app's own files and Tauri's IPC, with `script-src 'self'`: no eval and no WebAssembly. Never bring wasm back into the page: `'wasm-unsafe-eval'` doesn't work on WebKit before Safari 16 (macOS 12), so it would need `'unsafe-eval'`. `scripts/check-dist.mjs` (in `check:web`) fails if the build contains WebAssembly, libsodium, `eval` or `new Function`, or CSS `color-mix()` outside `@supports`. On desktop, `devCsp` is not applied in `tauri dev` (the page loads straight from Vite), so check CSP changes in a `tauri build --debug` bundle, which has the Web Inspector. Inspector console input is exempt from the CSP, so test by injecting a script element rather than calling `eval`. `freezePrototype` is on. Rust tests in `src-tauri/src/lib.rs` allow-list every source, so never add a remote origin. TypeScript is split into `tsconfig.app.json` (no tests, no Node types), `tsconfig.test.json` and `tsconfig.node.json`, all with `noUnusedLocals`/`noUnusedParameters`.

**The page talks only to the vault backend, in Rust.** [crates/still-core/src/vault/backend.rs](crates/still-core/src/vault/backend.rs) holds every rule about stored vault data; [src/platform/tauri/vaultApi.ts](src/platform/tauri/vaultApi.ts) is the page's only door to it.
- The page names Lenses and secrets by id. Each command returns the status and a key-free view (ids, names, labels, types, dates) or an error code. Keys, wrapped keys and encrypted values never reach the page; only the password, a value being saved, and a revealed value pass through it. Copying goes from the backend straight to the clipboard.
- The backend is generic over `Storage` (the vault file, `src-tauri/src/vault.rs`'s `FileStorage`, which reads the file on every operation) and `Keys` (the session's `Unlocked`; tests use a fast password step). It runs one operation at a time behind a mutex, so Lock waits for a change under way. Create and unlock are split into prepare, the Argon2id step (run outside the mutex) and finish; a counter makes a Lock in between win.
- Lists are `serde_json::Value`s (`preserve_order`, `float_roundtrip`), written back exactly as JavaScript's `JSON.stringify` wrote them. A list that couldn't be written back exactly (odd numbers, array-index keys, lone surrogates, deep nesting) is refused as unreadable. `vault/model.rs` holds pure list operations, `vault/time.rs` reads `deletedAt` as `new Date()` does for the ISO format, `vault/format.rs` the v1 shape checks.
- The app tells Rust to lock when it starts, since Rust keeps its keys across a page reload, then asks for the status. While unlocked it reports activity ([session.ts](src/platform/tauri/session.ts), at most every 15 s) and follows Rust's `vault-locked` event.
- [src/app/App.tsx](src/app/App.tsx) holds UI state only: the view, the selected Lens id, modals and toasts.

Backend rules; the tests (and `fixtures/vault-behaviour-v1`) depend on them:
- **Every change is written before it becomes visible,** as one all-or-nothing `Storage::write`. A Lens moving between lists is saved in both lists in that one write.
- **A failed write changes nothing** (`write-failed`).
- **Lenses are kept exactly as stored,** wrapped key and unknown fields included. Unlocking writes nothing but the Archive purge, and a Lens whose key can't be unwrapped is kept unchanged but hidden (`view.unreadable`).
- **A stored list that can't be read blocks unlocking** (`unreadable-data`), because any save would overwrite it.
- **Vault data without its key is orphaned.** `create` refuses to run, and the UI shows the recovery screen (`set_aside` copies everything to `still-set-aside-<time>-` keys first, adding a number if that prefix is taken).
- **Lock clears the lists and drops the keys at once,** and every change refuses while locked.

**Key hierarchy** (in Rust in [crates/still-core](crates/still-core); the JS reference is [src/test/reference/crypto.ts](src/test/reference/crypto.ts)):
1. Master password → Argon2id (`crypto_pwhash`, SENSITIVE limits, 16-byte salt) → a derived key that wraps a random 32-byte **app master key** (`encryptMasterKey` / `decryptMasterKey`).
2. Each Lens has its own random 32-byte **lens key**, wrapped by the app master key (`encryptLensMasterKey`).
3. Each item value is encrypted with a per-item subkey derived from the lens key: `crypto_kdf_derive_from_key` with context `StillSec` and a random uint32 subkey id (`encrypt` / `decrypt`).

All ciphers are XChaCha20-Poly1305 IETF. Ciphertexts are base64 (ORIGINAL variant) with a leading version byte, currently `1`. Item ciphertexts also store the subkey id as a 4-byte little-endian value after the version byte. Changing any of these formats breaks existing vaults, so bump the version byte and keep the decrypt path for older versions.

**Persistence is the vault file** ([store.rs](src-tauri/src/store.rs)): `vault.json` in the app-data folder (`~/Library/Application Support/com.still.app/` on macOS; debug builds use its `dev` subfolder, since they share the identifier). It holds the values below as the exact strings older versions kept in localStorage, under a header (`format: "still-vault"`, `formatVersion: 1`, `migratedFrom`). Writes are atomic (temp file, flush, rename, flush folder), `vault.json.bak` keeps the previous version (refreshed by copying, so `vault.json` never goes missing), a damaged file or a lone `.bak` is never written over, and the folder is 0700 and the files 0600. A `.lock` file held with `File::try_lock` lets one copy of Still at a time use the vault; a second gets `already-open`. The values:
- `still-encrypted-master-key`, `still-salt`, `still-has-pin`: vault setup. When the first two are missing, the app shows `CreatePasswordScreen`, or the recovery screen if any Lens data is left. `still-has-pin` is always written as `"false"`: the PIN never worked and was removed.
- `still-lenses`, `still-recycle-bin`: JSON arrays of lenses. Each lens has its wrapped key in `encryptedMasterKey`, and its items stay encrypted.

**The move from localStorage** ([startup.ts](src/platform/storage/startup.ts), run by [StillApp.tsx](src/app/StillApp.tsx)): with no vault file, every `still-*` localStorage value is copied unchanged into a new file (Rust refuses to overwrite one and checks it back), then `still-moved-to-file` records the time and a SHA-256 fingerprint. localStorage is never changed or deleted. Later starts use the file; if the old copy changed since (an older version ran), the app says so once. With the marker but no file, it reports the file missing and brings back the old copy only if asked. Downgrades after the move aren't supported: older versions only see the frozen old copy.

Older versions kept the vault in localStorage, which belongs to one origin and one WebKit data folder. On macOS (checked 2026-09-27), that's where the move reads from:
- **Release or bundled build:** origin `tauri://localhost`, data in `~/Library/WebKit/com.still.app/`. Both this folder and the vault file's come from `identifier`, so never change `identifier`.
- **`npm run tauri:dev`:** origin `http://localhost:3000`. The binary isn't bundled, so its data lives in `~/Library/WebKit/still/`, named after the executable. Keep the dev port at 3000; Vite uses `strictPort`, and tests pin both the port and `identifier`.

Recycle-bin entries older than 7 days are purged when the vault is unlocked. New ids are 128 random bits in hex. v0.1.0's ids were `Date.now().toString(36)`; they're kept as they are.

**Rust core.** [crates/still-core](crates/still-core) implements the v1 format byte for byte like the JS reference `crypto.ts`, on libsodium 1.0.22, the same release v0.1.x shipped, and the vault backend (`src/vault/`, described above).
- `sodium.rs` is the only `unsafe` code. Argon2id runs one at a time per process (a 1 GiB lock), so tests need no guard of their own.
- `format.rs` parses and writes blobs and never panics.
- `crypto.rs` holds the operations and the `Key` type, which is zeroed on drop and prints as `Key(redacted)`.
- `error.rs`: `WrongKey`, `Corrupt`, `PasswordHashFailed`, `EmptyPlaintext`, `NotUtf8`.
- `session.rs`: `Unlocked` holds the app key and the Lens keys that opened, built without any lock held (Argon2id takes seconds). `create()` derives the key a second time and refuses unless the new blob opens to the same app key, because a wrong derivation there would lock the vault forever. `SecretText` carries passwords and values, zeroes itself on drop and never prints. `SessionError::code()` gives the same codes as the JS `VaultCrypto`.

**The Tauri side** ([src-tauri/src](src-tauri/src)): `vault.rs` keeps the vault backend over the vault file in a `Mutex`, registered in `setup`; locking drops the keys. `commands.rs` holds the eighteen commands: `vault_state`, `vault_create`, `vault_unlock`, `vault_lock`, `vault_touch`, `vault_set_aside`, `lens_create`, `lens_rename`, `lens_forget`, `lens_restore`, `lens_delete`, `item_add`, `item_update`, `item_delete`, `item_reveal`, `item_copy`, and for start-up `storage_load` and `storage_import_legacy`. Argon2id runs in `spawn_blocking`, outside the mutex, and every command counts as activity. `build.rs` declares them, so Tauri refuses anything [capabilities/default.json](src-tauri/capabilities/default.json) doesn't allow: exactly these eighteen plus `core:event:allow-listen`/`allow-unlisten`, and `core:window:allow-start-dragging`/`allow-internal-toggle-maximize` so the overlay title bar can move and zoom the window (`data-tauri-drag-region`), for the `main` window, with no `core:default`.
- `clipboard.rs`: `item_copy` writes through `arboard` (used directly; the Tauri plugin wraps it), marked for clipboard history to skip. It clears after 30 s, on lock and on quit, only while the clipboard still holds that value, recognised by a keyed BLAKE2b fingerprint. Tests use a fake clipboard.
- `autolock.rs`: locks after 5 minutes idle (wall clock, so sleep counts) or when the wall clock runs ahead of the monotonic one (the computer slept). Debug builds accept `STILL_IDLE_SECONDS` (5 at least) for manual checks; release builds ignore it.
- `store.rs`: the vault file, as described under Persistence. Its tests use temporary folders and import the real exported vault.
- `watcher.rs`: one thread, ticking every second: auto-lock (then clears the clipboard and emits `vault-locked` with `idle` or `sleep`) and the clipboard's 30-second clear. Adding a command means updating all three places; a test checks they agree.

Differences from `crypto.ts`, on purpose:
- Every decrypt checks the version byte, including the master key's.
- Damaged master-key data is `Corrupt` before any Argon2id run.
- Blank values are refused using JavaScript's definition of whitespace.

Other notes:
- `tests/golden_v1.rs` and `tests/vectors_v1.rs` must always pass.
- libsodium is always built at `opt-level = 3` (root `Cargo.toml`), or Argon2id tests take minutes.
- Building needs a C compiler (Xcode Command Line Tools on macOS, build-essential on Linux). Run `cargo test -p still-core` for this crate alone.

## Conventions

- **The design system** (approved on a mockup, 2026-10-05) lives in [globals.css](src/app/globals.css) and [src/shared/ui](src/shared/ui). Style components with Tailwind classes on its tokens only, never hard-coded colours:
  - colours: surfaces `bg`, `sidebar`, `raised`, `field`, `hover`, `selected`, `hairline`; greys `g1` (primary text) to `g7`, which alone carry the hierarchy; `danger`, `warning`, `success`; the accent, Ink (`accent-fill` for buttons with `on-accent` text, `accent` for rings, selected icons and the glow, `accent-text`, `accent-soft`); `wash` for hover backgrounds. Each has light and dark values, and the app follows the system. Every text and icon pair passes WCAG AA; check new pairs.
  - type: Geist and Geist Mono (Fontsource, bundled), sizes `text-12/13/14/16` only, weights 400/500/600.
  - radii `rounded-4/6/8/12`; spacing on a 4px grid.
  - icons: only `Icon` (Still's own set, 16px, 1.5px stroke); no icon library.
  - motion: none on frequent actions; colour changes over 150ms; name the transitioned properties (never `transition: all`); Tailwind 4's `scale-*` sets the `scale` property, so transition `scale`, not `transform`. Respect reduced motion (keep fades, drop movement).
  - controls: use the shared pieces (Button, IconButton, TextField, SegmentedControl, Menu, Dialog, Toaster, Kbd). Focus shows through the `focus-ring` utility, a box-shadow, because Safari before 16.4 draws outlines with square corners. `hover:` applies only on a real pointer.
- **Styles: Tailwind 4 must work on macOS 12's Safari 15.4.** `@tailwindcss/vite` builds the CSS, and Vite runs Lightning CSS with a Safari 15.4 target, in dev and release, which adds fallbacks for newer CSS. Avoid what it can't fix: `color-mix()` (opacity modifiers like `bg-black/50` on token colours; use a token or an rgb() value), Tailwind's gradient utilities (they interpolate `in oklab`; write the gradient in an arbitrary property), `@starting-style` (use a `data-mounted` attribute set a frame after mounting) and CSS nesting. In `globals.css`, our own element rules live in `@layer base`, so utility classes beat them (unlayered rules would beat every utility). Only `src/` and `index.html` are scanned for classes. Fonts must never be inlined as `data:` URLs (`font-src 'self'` blocks them); `vite.config.ts` and `check-dist` make sure.
- UI tests replace the vault commands with [src/test/fakeVaultApi.ts](src/test/fakeVaultApi.ts), which follows their contract (states, error codes, nothing while locked); the reference crypto tests use [src/test/fakeCrypto.ts](src/test/fakeCrypto.ts), which makes real v1 blob shapes and throws libsodium's real error messages. In happy-dom, spy on `localStorage` itself, not `Storage.prototype` (that spy sees nothing), and restore it with `mockRestore()`, because `vi.restoreAllMocks()` doesn't.
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