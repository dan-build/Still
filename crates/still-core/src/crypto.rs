//! The v1 vault operations, byte for byte the same as the original
//! crypto.ts (the JavaScript code v0.1.x shipped; removed, in the git history):
//!
//! 1. Master password → Argon2id (SENSITIVE) with a 16-byte salt → a key that
//!    wraps the 32-byte app key.
//! 2. The app key wraps each Lens's own 32-byte key.
//! 3. Each item is encrypted with a subkey derived from its Lens key by
//!    crypto_kdf (context "StillSec", random u32 id stored in the blob).
//!
//! All with XChaCha20-Poly1305 IETF and no associated data. Unlike crypto.ts,
//! every decrypt checks the version byte (only 1 has ever been written).

use crate::error::Error;
use crate::format::{
    encode_item_blob, encode_key_blob, parse_item_blob, parse_key_blob, parse_salt, ItemBlob,
    KeyBlob, KEY_BYTES, NONCE_BYTES, SALT_BYTES,
};
use crate::sodium;

pub const KDF_CONTEXT: &[u8; 8] = b"StillSec";

/// A 32-byte secret key. Zeroed when dropped, and never printed.
pub struct Key(Box<[u8; KEY_BYTES]>);

impl Key {
    pub fn from_bytes(bytes: [u8; KEY_BYTES]) -> Self {
        let mut key = Key(Box::new([0; KEY_BYTES]));
        key.0.copy_from_slice(&bytes);
        key
    }

    /// A fresh random key (the app key or a new Lens key).
    pub fn random() -> Self {
        let mut key = Key(Box::new([0; KEY_BYTES]));
        sodium::random_bytes(&mut key.0[..]);
        key
    }

    /// Whether two keys are equal, compared in constant time.
    pub fn same_as(&self, other: &Key) -> bool {
        sodium::memeq(&self.0[..], &other.0[..])
    }

    /// The raw bytes. Only for tests that compare against known vectors.
    #[doc(hidden)]
    pub fn expose(&self) -> &[u8; KEY_BYTES] {
        &self.0
    }
}

impl Drop for Key {
    fn drop(&mut self) {
        sodium::memzero(&mut self.0[..]);
    }
}

impl std::fmt::Debug for Key {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str("Key(redacted)")
    }
}

fn random_nonce() -> [u8; NONCE_BYTES] {
    let mut nonce = [0; NONCE_BYTES];
    sodium::random_bytes(&mut nonce);
    nonce
}

/// Argon2id with libsodium's SENSITIVE limits over the password's UTF-8 bytes.
pub fn derive_key_from_password(password: &str, salt: &[u8; SALT_BYTES]) -> Result<Key, Error> {
    let mut key = Key(Box::new([0; KEY_BYTES]));
    sodium::argon2id_sensitive(&mut key.0, password.as_bytes(), salt)
        .map_err(|_| Error::PasswordHashFailed)?;
    Ok(key)
}

/// Wraps `key` with `wrapping_key` into a v1 key blob, using the given nonce.
/// Exposed for test vectors; everything else uses a random nonce.
#[doc(hidden)]
pub fn wrap_key_with_nonce(key: &Key, wrapping_key: &Key, nonce: [u8; NONCE_BYTES]) -> String {
    let sealed = sodium::aead_encrypt(&key.0[..], &nonce, &wrapping_key.0);
    let mut blob = KeyBlob {
        nonce,
        sealed: [0; KEY_BYTES + 16],
    };
    blob.sealed.copy_from_slice(&sealed);
    encode_key_blob(&blob)
}

fn unwrap_key(blob: &str, wrapping_key: &Key) -> Result<Key, Error> {
    let blob = parse_key_blob(blob)?;
    let mut opened = sodium::aead_decrypt(&blob.sealed, &blob.nonce, &wrapping_key.0)
        .map_err(|_| Error::WrongKey)?;
    let mut key = Key(Box::new([0; KEY_BYTES]));
    key.0.copy_from_slice(&opened);
    sodium::memzero(&mut opened);
    Ok(key)
}

/// Wraps the app key with a key derived from `password` and a fresh salt.
/// Returns (key blob, salt), both base64, as stored.
pub fn encrypt_master_key(app_key: &Key, password: &str) -> Result<(String, String), Error> {
    let mut salt = [0u8; SALT_BYTES];
    sodium::random_bytes(&mut salt);
    let password_key = derive_key_from_password(password, &salt)?;
    Ok((
        wrap_key_with_nonce(app_key, &password_key, random_nonce()),
        sodium::to_base64(&salt),
    ))
}

/// Unwraps the app key. Damaged data is `Corrupt` before the password is
/// tried; a wrong password is `WrongKey`.
pub fn decrypt_master_key(blob: &str, password: &str, salt: &str) -> Result<Key, Error> {
    let salt = parse_salt(salt)?;
    parse_key_blob(blob)?;
    let password_key = derive_key_from_password(password, &salt)?;
    unwrap_key(blob, &password_key)
}

/// Wraps a Lens key with the app key.
pub fn encrypt_lens_key(lens_key: &Key, app_key: &Key) -> String {
    wrap_key_with_nonce(lens_key, app_key, random_nonce())
}

pub fn decrypt_lens_key(blob: &str, app_key: &Key) -> Result<Key, Error> {
    unwrap_key(blob, app_key)
}

/// JavaScript's String.prototype.trim whitespace (WhiteSpace and
/// LineTerminator), so blank values are refused exactly as in the app.
pub fn is_js_whitespace(c: char) -> bool {
    matches!(
        c,
        '\u{0009}'
            | '\u{000A}'
            | '\u{000B}'
            | '\u{000C}'
            | '\u{000D}'
            | '\u{0020}'
            | '\u{00A0}'
            | '\u{1680}'
            | '\u{2000}'
            ..='\u{200A}'
                | '\u{2028}'
                | '\u{2029}'
                | '\u{202F}'
                | '\u{205F}'
                | '\u{3000}'
                | '\u{FEFF}'
    )
}

/// Encrypts an item with a fresh subkey id and nonce. Refuses values that
/// are empty or only whitespace, as the app does.
pub fn encrypt_item(plaintext: &str, lens_key: &Key) -> Result<String, Error> {
    encrypt_item_with(plaintext, lens_key, sodium::random_u32(), random_nonce())
}

/// Encrypts an item with the given subkey id and nonce. Exposed for test
/// vectors; everything else uses encrypt_item.
#[doc(hidden)]
pub fn encrypt_item_with(
    plaintext: &str,
    lens_key: &Key,
    subkey_id: u32,
    nonce: [u8; NONCE_BYTES],
) -> Result<String, Error> {
    if plaintext.chars().all(is_js_whitespace) {
        return Err(Error::EmptyPlaintext);
    }
    let subkey = derive_subkey(lens_key, subkey_id);
    let sealed = sodium::aead_encrypt(plaintext.as_bytes(), &nonce, &subkey.0);
    Ok(encode_item_blob(&ItemBlob {
        subkey_id,
        nonce,
        sealed,
    }))
}

pub fn decrypt_item(blob: &str, lens_key: &Key) -> Result<String, Error> {
    let blob = parse_item_blob(blob)?;
    let subkey = derive_subkey(lens_key, blob.subkey_id);
    let bytes =
        sodium::aead_decrypt(&blob.sealed, &blob.nonce, &subkey.0).map_err(|_| Error::WrongKey)?;
    String::from_utf8(bytes).map_err(|e| {
        let mut bytes = e.into_bytes();
        sodium::memzero(&mut bytes);
        Error::NotUtf8
    })
}

/// crypto_kdf_derive_from_key(32, id, "StillSec", lens key).
#[doc(hidden)]
pub fn derive_subkey(lens_key: &Key, subkey_id: u32) -> Key {
    let mut subkey = Key(Box::new([0; KEY_BYTES]));
    sodium::kdf_derive(
        &mut subkey.0,
        u64::from(subkey_id),
        KDF_CONTEXT,
        &lens_key.0,
    );
    subkey
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::format::FormatError;

    #[test]
    fn items_round_trip_exactly_including_edge_whitespace_and_unicode() {
        let lens = Key::random();
        for text in [
            "sk-test",
            "  spaced out \n",
            "hunter2-Ünïcødé-密码-🔐",
            "line one\nline two",
            &"y".repeat(10_000),
        ] {
            let blob = encrypt_item(text, &lens).unwrap();
            assert_eq!(decrypt_item(&blob, &lens).unwrap(), text);
        }
    }

    #[test]
    fn every_encryption_uses_a_fresh_subkey_id_and_nonce() {
        let lens = Key::random();
        let a = parse_item_blob(&encrypt_item("same", &lens).unwrap()).unwrap();
        let b = parse_item_blob(&encrypt_item("same", &lens).unwrap()).unwrap();
        assert_ne!((a.subkey_id, a.nonce), (b.subkey_id, b.nonce));
    }

    #[test]
    fn refuses_blank_values_by_javascripts_definition_of_whitespace() {
        let lens = Key::random();
        for blank in ["", "   ", "\n\t", "\u{FEFF}", "\u{00A0}\u{3000}"] {
            assert_eq!(
                encrypt_item(blank, &lens),
                Err(Error::EmptyPlaintext),
                "{blank:?}"
            );
        }
        // U+0085 is whitespace to Rust but not to JavaScript's trim.
        assert!(encrypt_item("\u{0085}", &lens).is_ok());
    }

    #[test]
    fn wrong_keys_and_changed_bytes_are_wrong_key() {
        let lens = Key::random();
        let blob = encrypt_item("secret", &lens).unwrap();
        assert_eq!(decrypt_item(&blob, &Key::random()), Err(Error::WrongKey));

        let mut bytes = sodium::from_base64(&blob).unwrap();
        let last = bytes.len() - 1;
        bytes[last] ^= 1;
        assert_eq!(
            decrypt_item(&sodium::to_base64(&bytes), &lens),
            Err(Error::WrongKey)
        );

        let app = Key::random();
        let wrapped = encrypt_lens_key(&lens, &app);
        assert_eq!(
            decrypt_lens_key(&wrapped, &app).unwrap().expose(),
            lens.expose()
        );
        assert_eq!(
            decrypt_lens_key(&wrapped, &Key::random()).unwrap_err(),
            Error::WrongKey
        );
    }

    #[test]
    fn other_versions_are_corrupt_not_wrong_key() {
        let lens = Key::random();
        let mut bytes = sodium::from_base64(&encrypt_item("secret", &lens).unwrap()).unwrap();
        bytes[0] = 2;
        assert_eq!(
            decrypt_item(&sodium::to_base64(&bytes), &lens),
            Err(Error::Corrupt(FormatError::UnsupportedVersion(2)))
        );
    }

    #[test]
    fn keys_never_print_their_bytes() {
        assert_eq!(format!("{:?}", Key::from_bytes([7; 32])), "Key(redacted)");
    }

    #[test]
    fn master_key_round_trips_and_damage_is_reported_before_the_password() {
        let app = Key::random();
        let (blob, salt) = encrypt_master_key(&app, "correct horse").unwrap();
        assert_eq!(
            decrypt_master_key(&blob, "correct horse", &salt)
                .unwrap()
                .expose(),
            app.expose()
        );
        assert_eq!(
            decrypt_master_key(&blob, "wrong horse", &salt).unwrap_err(),
            Error::WrongKey
        );
        // Damaged data fails fast, without spending an Argon2id run.
        assert!(matches!(
            decrypt_master_key("AAAA", "x", &salt),
            Err(Error::Corrupt(_))
        ));
        assert!(matches!(
            decrypt_master_key(&blob, "x", "AAAA"),
            Err(Error::Corrupt(_))
        ));
    }
}
