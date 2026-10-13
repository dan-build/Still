# Vault format v2: design

Status: **approved by the owner on 2026-10-13**, after an independent cryptography review.

## Why

In v1 (the format every Still vault uses today) only the secret values are encrypted. `vault.json` holds the Lens list and the Archive as readable JSON:

- **Metadata is readable.** Lens names, secret labels, types, creation and deletion dates, and how many secrets each Lens holds can be read by anything that can read the file: a backup, a sync folder, other software on the Mac.
- **Nothing ties an encrypted value to its place.** Someone who can write the file can swap the values of two secrets, put back an older value, or edit a `deletedAt` so the 7-day purge deletes a Lens for good. None of it is detected (audit findings S5 and S6).
- **The Argon2id settings aren't recorded** (audit S7). They are fixed in code, so they can never be raised without breaking existing vaults.

v2 fixes all three. It changes only how the vault is written inside `vault.json`. The app, its features, the master password and the crypto primitives (Argon2id, XChaCha20-Poly1305, BLAKE2b, all from libsodium) stay the same. Nothing custom.

## Decisions (owner, 2026-10-13)

- **Encrypt everything** in the vault body, not only names and labels.
- **Convert automatically on the first unlock** after the update.
- **Keep the v1 file** beside the new one until the user deletes it.

## The v2 file

```json
{
  "format": "still-vault",
  "formatVersion": 2,
  "kdf": { "algorithm": "argon2id13", "opsLimit": 4, "memLimit": 1073741824, "salt": "<16 bytes, base64>" },
  "masterKey": "<v2 key blob, base64>",
  "body": "<v2 body blob, base64>",
  "check": "<BLAKE2b-256 of the header, hex>",
  "migratedFrom": "vault-v1"
}
```

Only the header is readable: the format, the Argon2id settings and salt, the two blobs, a checksum, and where the vault came from. **Nothing about the user's secrets is visible.** The body is padded so its size shows only roughly how much it holds.

Header rules:
- **Strict parsing.**
  - `formatVersion` and the two limits are plain decimal integers that fit a u64: no `4.0`, no `1e9`, no sign.
  - The salt must decode as canonical base64 to exactly 16 bytes, and `masterKey` to exactly 73.
  - **Unknown fields are refused** as damaged data. A future change needs a new `formatVersion`.
- **`migratedFrom` is informational only.** Nothing in the app ever acts on it.
- **`check`** is an unkeyed BLAKE2b of the header fields. It only lets accidental damage, such as a disk error or a hand edit, show as damaged data instead of a wrong password. It's not a security measure: an attacker can recompute it.

### Keys

Unchanged from v1, plus one derived key:

1. Master password → Argon2id with the settings in `kdf` → **password key**. It wraps the 32-byte **app key** (`masterKey`), and nothing else.
2. App key → `crypto_kdf_derive_from_key(32, id 1, context "StillVlt", app key)` → **body key**. Nothing new is stored.
3. Each Lens keeps its own key, wrapped by the app key, and each secret value stays encrypted with its per-item subkey, exactly as in v1. These now sit *inside* the body, so a value is encrypted twice: once on its own, once as part of the body.
   - The decrypted body in memory holds no secret values.
   - Revealing a secret still decrypts only that one value.
   - Conversion is lossless.

   The app key also stays the direct key for wrapping Lens keys, as in v1. The cipher and the KDF are unrelated (XChaCha20, keyed BLAKE2b), so there's no known interaction. Changing it would break v1 compatibility, so it stays, on purpose.

### Blobs

Both v2 blobs are XChaCha20-Poly1305 IETF with associated data, base64 (ORIGINAL variant), a version byte of `2` and a random 24-byte nonce:

| Blob | Bytes | Associated data (authenticated, not stored) |
|---|---|---|
| `masterKey` | `[2][nonce 24][app key 32 + tag 16]` = 73 | `"still-vault/2/master-key"` `0x00` ‖ KDF block |
| `body` | `[2][nonce 24][ciphertext + tag 16]` | `"still-vault/2/body"` `0x00` ‖ KDF block ‖ the 73 `masterKey` bytes |

The **KDF block** is a fixed binary layout built from the parsed values, so JSON spacing or key order never matters:
- 1 byte: the algorithm id, `2` for argon2id13 (libsodium's value);
- 8 bytes: the ops limit, u64 little-endian;
- 8 bytes: the mem limit, u64 little-endian;
- 16 bytes: the salt.

The associated data ties each part to the rest of the file. Changing the settings, the salt or the wrapped app key makes the vault fail to open, and so does moving a body to another vault. `formatVersion` is bound by the domain strings and the version byte.

**When each part is written:**
- **The body** is resealed on every save, with a fresh nonce.
- **`kdf` and `masterKey`** are copied unchanged on every save. They change only when a vault is created or converted, or by a future password change.
- **While locked** there is no body key, so nothing can be saved, which matches the rule that changes refuse while locked.

Random 192-bit nonces make reuse not a practical concern.

### The body

The body's plaintext is a length-prefixed JSON document, padded:

```
[u32 little-endian: JSON length][JSON][zero bytes up to the next multiple of 4096]
```

The JSON holds the two v1 list strings **as strings**:

```json
{ "lenses": "<the v1 still-lenses string>", "bin": "<the v1 still-recycle-bin string>" }
```

Keeping them as strings makes "exactly as stored" trivial: conversion and its checks compare strings byte for byte. The v1 rules carry over unchanged: unreadable Lenses kept as stored, the Archive and its purge, unknown fields, the JSON rules of `vault/json.rs`.

`still-has-pin` is dropped. It has always been `"false"`, and the PIN was removed in v0.1.1.

The decrypted body (the plaintext and its buffers) is zeroed after use, like other secrets in Rust. Copies serde_json makes while parsing can't be zeroed, so it parses as little as possible. As today, the page still receives the names and labels it shows.

### Argon2id settings

v2 accepts only `argon2id13` with ops limit **4 to 16** and mem limit **1 GiB to 4 GiB**:
- The lower bounds are libsodium's SENSITIVE limits, so an edited header can't weaken a vault.
- The upper bounds stop an edited header from hanging the app or running it out of memory before anything is authenticated.

Anything outside them is damaged data, reported before Argon2id runs. Raising the settings later is possible without a new format, but isn't part of this change.

### Errors

Wrong password and tampering can't always be told apart. A changed salt, setting or wrapped key and a wrong password all fail the same check, and nothing under the password key can distinguish them. So:

| What fails | Reported as |
|---|---|
| JSON, base64, field ranges, unknown fields, or `check` mismatch (before Argon2id) | damaged data |
| `masterKey` doesn't open | wrong password (which can also mean the file was tampered with) |
| `body` doesn't open after `masterKey` did | damaged data |

**After any number of wrong-password results, the app never offers anything destructive,** such as a new vault or setting data aside. An attacker who can write the file can make the right password look wrong. That only blocks access, but a user who thinks they've forgotten the password mustn't be led to destroy the vault. SECURITY.md will say this.

## Converting from v1

On the first successful unlock of a v1 vault, before anything else is saved. All of it runs under the vault's `.lock`:

1. Read `vault.json` **once into one buffer**, and unlock v1 from it exactly as today (the master key, then every Lens key). Nothing is written yet.
2. Build the v2 file in memory:
   - the same app key, re-wrapped under a **new salt** with v2 associated data;
   - the body from the stored lists **exactly as stored** (before the Archive purge).
3. **Verify in memory:**
   - derive the password key **again, independently**, and check the new `masterKey` opens to the same app key (as `create()` does today);
   - decrypt the body and check both list strings equal the stored v1 strings, byte for byte.

   If anything differs, stop. Nothing is written, the vault stays v1 and opens as normal, and conversion is tried at the next unlock.
4. **Keep the v1 file, crash-safe:**
   1. write the exact buffer from step 1 to a temp file and flush it;
   2. link it to `vault-v1.json` without replacing anything (`link()`, or `renamex_np` with `RENAME_EXCL` on macOS; the matching calls on Windows and Linux), then flush the folder;
   3. read it back and compare with the buffer.
   - If `vault-v1.json` already exists and is byte-identical, carry on.
   - If it exists and differs, use the first free `vault-v1-2.json`, `vault-v1-3.json`, and so on. (Numbers rather than the time: a time has `:`, which Windows file names can't.) Never write over a kept copy, and never stop for good because one exists.
5. Write the v2 file atomically over `vault.json`, as every write does today: temp file, flush, rename, flush the folder.
6. Read the file back and open it with the keys in memory. If it doesn't open to the same lists, restore the kept v1 file over `vault.json` and report the failure.
7. Record the **conversion marker** (see "Older copies" below).
8. Carry on with the normal unlock: open the lists, purge expired Archive entries, and so on, now saving in v2.

Conversion costs **two extra Argon2id runs**: one for the new salt, and one to verify it independently. It happens once, so that unlock takes several seconds longer and shows the usual unlocking glow.

**After a crash:**

| Crash point | State at the next start |
|---|---|
| Before step 4 finishes | `vault.json` is v1 and untouched; conversion is tried again. |
| During step 5 | The old file is still in place, because the write is atomic. |
| Between steps 5 and 6 | If the next start finds a v2 `vault.json` that doesn't open while a kept v1 file exists, Still says so and offers to **restore the kept v1 file**. It never stops at "damaged" alone, and it never deletes anything. |

Still never writes over or deletes `vault-v1.json` (or a numbered copy). The old localStorage copy from before v0.2.0 also stays as it is (v1). The move from localStorage still writes a v1 file, which is then converted at its first unlock.

## Older copies after conversion

After conversion, v1 copies exist in several places:
- `vault-v1.json`;
- `vault.json.bak`, until the next save;
- the localStorage copy;
- Time Machine and other backups.

An attacker who can write files could **edit** one of these (swap values, change a `deletedAt`) and put it in as `vault.json`. In v1 that edit can't be detected. Converting it would even seal the forgery into an authenticated v2 vault.

So conversion records a **marker**, `still-converted-v2` in localStorage next to `still-moved-to-file`, holding the date and a fingerprint of the converted vault. Like the move marker, the page writes it and Rust decides. **If `vault.json` is v1 and the marker exists,** Still neither opens it silently nor converts it. It shows: "This vault is in the old format, but it was upgraded on <date>. Opening it uses an older or changed copy." Only an explicit **Open anyway** opens it.

This stops attackers who can only touch files, such as through a synced folder or a restored backup. Someone with full access to the user's account can delete the marker, which SECURITY.md will say. Anything changed in a v1 vault *before* it was converted is kept as it was. Existing vaults keep opening, so the owner's rule holds: the guard adds a question, never a refusal.

## Older versions

v0.5.0 and older read only `formatVersion: 1`. Given a v2 file, they report "Still can't read its vault file" and **write nothing**: `store.rs` never writes over a file it can't read. Going back is therefore safe, but it needs `vault-v1.json`, which lacks any change made after the conversion. The README will say so, as it does for the move to the vault file.

## What it does and doesn't protect

**Protects:**
- Names, labels, types, dates and counts are no longer readable from the file, and its size is rounded to 4 KiB.
- Any edit, swap, partial rollback or splice inside a v2 file is detected, and nothing is changed or deleted because of it.
- A weakened or extreme Argon2id setting is refused.
- An older v1 copy can't quietly stand in for a converted vault.

**Doesn't protect** (to say in SECURITY.md):
- **Rolling back the whole v2 file** to an older, complete v2 copy (from a backup, say). It opens. Detecting that would need state outside the file, which a local-only app doesn't have.
- **An attacker who can write the file can make the right password look wrong.** That denies access, but reveals nothing.
- **Someone with full access to the user's account** (who can delete the marker), and a device already compromised while the vault is unlocked, as today.

## Inside the app

- **`crates/still-core`:**
  - in `sodium.rs` (the only unsafe module): add an `ad: &[u8]` argument to the existing AEAD wrappers, so v1 calls pass an empty one;
  - the v2 blobs, the header and its checks, the body framing and padding, and conversion.
- **`src-tauri/src/store.rs`:**
  - reads and writes `formatVersion` 1 and 2;
  - keeps the v1 copy crash-safe;
  - restores it on request.
- **The backend's logic doesn't change.** It keeps working on the same logical list strings. A small layer between the backend and the file opens and seals the body with the body key while unlocked, and holds nothing while locked. The behaviour fixture (`fixtures/vault-behaviour-v1`) replays unchanged against that layer.
- **While locked,** the status comes from the header alone. Orphaned data in v2 means a body without a usable header; set-aside moves the file aside instead of copying keys.
- **Start-up (`startup.rs`)** gains the conversion marker and the "upgraded on <date> — Open anyway" question.
- **The page** gains:
  - two notices: "Your vault was upgraded to the new format. The previous file is kept as vault-v1.json." and the restore offer;
  - the Open anyway question.

## Tests

Tests come before the code they cover:

- **A new golden fixture, `fixtures/vault-v2`:** a v2 vault made once from `vault-v1`'s contents, with fixed nonces and salt, plus vectors for the AD layout, the body framing and the body key. Any implementation must open it exactly. The v1 fixtures stay unchanged.
- **Conversion of all three golden v1 vaults and the owner's real throwaway vault:**
  - each converts;
  - the body holds the v1 list strings byte for byte;
  - every secret reveals exactly;
  - the kept `vault-v1.json` equals the original file.
- **Failure and crash injection at every step:**
  - v1 stays intact and openable;
  - a kept copy is never written over (a different one gets a numbered name);
  - conversion is retried;
  - a v2 file that won't open next to a kept v1 offers the restore.
- **Tampering:**
  - any change to the header fields is damaged data (before Argon2id) or a wrong password, as in the error table;
  - any change to the body is damaged data;
  - a body moved to another vault doesn't open;
  - out-of-range settings are refused before Argon2id;
  - unknown fields are refused;
  - in every case, nothing is written.
- **The conversion marker:**
  - a v1 file after conversion asks before opening and is never converted silently;
  - without the marker, v1 converts as normal.
- **Unchanged rules:** the behaviour fixture still replays exactly, and the golden v1 vaults still open.
- **Older versions:** a check that v0.5.0's store reads a v2 file as unreadable and writes nothing.
- **Manual checks:**
  - convert the dev and the throwaway vault on screen;
  - confirm `vault-v1.json`;
  - reopen both;
  - put a v1 copy back and see the Open anyway question.

## Steps

Each step is one commit, green on `npm run check`, on branch `stage-v2`, each reviewed by a subagent:

1. The v2 fixture and vectors, with the crypto behind them: AEAD with associated data, the body key, the header, framing and padding.
2. Reading and writing the v2 file in `store.rs`, and the layer between the backend and the file.
3. Conversion on first unlock: the crash-safe v1 copy, the read-back, the restore offer, and the marker with its "Open anyway" question.
4. The notices, the README, SECURITY.md (what's encrypted, the error table, the rollback limit, going back), CLAUDE.md and the changelog.
5. Manual checks; then a release (v0.6.0).
