//! An unlocked vault: the app key and every Lens key that opened, held
//! here and never handed out. Callers pass encrypted blobs in and get blobs
//! (or, for a reveal, the plaintext) back, and name Lens keys by Lens id.
//!
//! `Unlocked` is built without any lock held, so the slow Argon2id run never
//! blocks anything else. Locking is dropping it: every `Key` zeroes itself.

use std::collections::HashMap;

use crate::crypto::{
    decrypt_item, decrypt_lens_key, decrypt_master_key, encrypt_item, encrypt_lens_key,
    encrypt_master_key, Key,
};
use crate::error::Error;
use crate::sodium;
use crate::v2;

/// Why a session operation failed. `code()` is all the UI ever sees, the
/// same codes the page's VaultCrypto used before the vault moved to Rust.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum SessionError {
    /// The password didn't open the master key.
    WrongPassword,
    /// Stored data is damaged or in an unknown format.
    Corrupt,
    /// Anything else, such as Argon2id running out of memory.
    Failed,
    /// No vault is unlocked.
    Locked,
    /// No key is held for that Lens id.
    UnknownLens,
}

impl SessionError {
    pub fn code(self) -> &'static str {
        match self {
            Self::WrongPassword => "wrong-password",
            Self::Corrupt => "corrupt",
            Self::Failed => "failed",
            Self::Locked => "locked",
            Self::UnknownLens => "unknown-lens",
        }
    }
}

impl std::fmt::Display for SessionError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(self.code())
    }
}

impl std::error::Error for SessionError {}

/// A password or secret value. Its bytes, including spare capacity, are
/// zeroed when dropped, and it never prints.
pub struct SecretText(String);

impl SecretText {
    pub fn expose(&self) -> &str {
        &self.0
    }
}

impl From<String> for SecretText {
    fn from(text: String) -> Self {
        Self(text)
    }
}

impl Drop for SecretText {
    fn drop(&mut self) {
        let mut bytes = std::mem::take(&mut self.0).into_bytes();
        bytes.resize(bytes.capacity(), 0);
        sodium::memzero(&mut bytes);
    }
}

impl std::fmt::Debug for SecretText {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str("SecretText(redacted)")
    }
}

/// A Lens's id and its key as stored: wrapped by the app key.
pub struct WrappedLensKey<'a> {
    pub id: &'a str,
    pub encrypted_master_key: &'a str,
}

/// The keys of an unlocked vault.
pub struct Unlocked {
    app_key: Key,
    lens_keys: HashMap<String, Key>,
}

impl Unlocked {
    /// A new vault: a fresh app key, wrapped by the password. Returns the
    /// session and the (key blob, salt) to store.
    ///
    /// Before returning, it proves the blob opens with the password, by
    /// deriving the key a second time. A wrong derivation here would lock the
    /// vault forever, so nothing is handed out to be stored unless it opens.
    pub fn create(password: &SecretText) -> Result<(Self, String, String), SessionError> {
        let app_key = Key::random();
        let (blob, salt) =
            encrypt_master_key(&app_key, password.expose()).map_err(|_| SessionError::Failed)?;
        verify_master_key(&app_key, &blob, &salt, password)?;
        let session = Self {
            app_key,
            lens_keys: HashMap::new(),
        };
        Ok((session, blob, salt))
    }

    /// Opens the master key, then each Lens key. Returns the session and one
    /// entry per Lens, in order: true if its key opened. A Lens whose key
    /// doesn't open is simply not held.
    pub fn open(
        encrypted_master_key: &str,
        salt: &str,
        password: &SecretText,
        lenses: &[WrappedLensKey<'_>],
    ) -> Result<(Self, Vec<bool>), SessionError> {
        let app_key = decrypt_master_key(encrypted_master_key, password.expose(), salt)
            .map_err(unlock_error)?;
        let mut session = Self {
            app_key,
            lens_keys: HashMap::new(),
        };
        let opened = session.open_lens_keys(lenses);
        Ok((session, opened))
    }

    /// Opens each Lens key with the app key and keeps those that open. One
    /// entry per Lens, in order: true if its key opened.
    pub fn open_lens_keys(&mut self, lenses: &[WrappedLensKey<'_>]) -> Vec<bool> {
        lenses
            .iter()
            .map(
                |lens| match decrypt_lens_key(lens.encrypted_master_key, &self.app_key) {
                    Ok(key) => {
                        self.lens_keys.insert(lens.id.to_owned(), key);
                        true
                    }
                    Err(_) => false,
                },
            )
            .collect()
    }

    /// A new vault in format v2: a fresh app key, wrapped under the password
    /// with SENSITIVE settings and a fresh salt, and an empty body. As with
    /// `create`, the password key is derived a second time and the file
    /// must open to the same app key before it is handed out.
    pub fn create_v2(password: &SecretText) -> Result<(Self, v2::File), SessionError> {
        let app_key = Key::random();
        let kdf = v2::Kdf::new_sensitive();
        let password_key = kdf
            .password_key(password.expose())
            .map_err(|_| SessionError::Failed)?;
        let empty = v2::Body {
            lenses: "[]".into(),
            bin: "[]".into(),
        };
        let file = v2::seal_file(&app_key, &password_key, kdf, &empty, None);
        drop(password_key);
        let (session, _) = Self::open_v2(&file, password).map_err(|_| SessionError::Failed)?;
        if !session.app_key.same_as(&app_key) {
            return Err(SessionError::Failed);
        }
        Ok((session, file))
    }

    /// Opens a v2 file: Argon2id with its recorded settings, the app key,
    /// then the body. Lens keys are opened afterwards from the body's lists
    /// (`open_lens_keys`). A key that doesn't open is `WrongPassword`; a body
    /// that doesn't open after it is `Corrupt`.
    pub fn open_v2(
        file: &v2::File,
        password: &SecretText,
    ) -> Result<(Self, v2::Body), SessionError> {
        let password_key = file
            .kdf
            .password_key(password.expose())
            .map_err(unlock_error)?;
        let app_key = file.open_master_key(&password_key).map_err(unlock_error)?;
        let body = file.open_body(&app_key).map_err(unlock_error)?;
        let session = Self {
            app_key,
            lens_keys: HashMap::new(),
        };
        Ok((session, body))
    }

    /// This vault (opened from v1) in format v2: the app key wrapped under a
    /// new salt with SENSITIVE settings, and the given lists sealed in. It
    /// is checked before it's returned, with a second, independent Argon2id
    /// run: it must open to this very app key and to these very lists.
    pub fn convert_v2(
        &self,
        password: &SecretText,
        body: &v2::Body,
    ) -> Result<v2::File, SessionError> {
        let kdf = v2::Kdf::new_sensitive();
        let password_key = kdf
            .password_key(password.expose())
            .map_err(|_| SessionError::Failed)?;
        let file = v2::seal_file(
            &self.app_key,
            &password_key,
            kdf,
            body,
            Some("vault-v1".into()),
        );
        drop(password_key);
        let (check, opened) = Self::open_v2(&file, password).map_err(|_| SessionError::Failed)?;
        let same = check.app_key.same_as(&self.app_key)
            && opened.lenses == body.lenses
            && opened.bin == body.bin;
        if same {
            Ok(file)
        } else {
            Err(SessionError::Failed)
        }
    }

    /// The same file with this body sealed in (for a save). Its settings and
    /// wrapped app key stay as they are.
    pub fn seal_v2(&self, file: &v2::File, body: &v2::Body) -> v2::File {
        file.with_body(body, &self.app_key)
    }

    /// Makes and keeps a key for a new Lens. Returns it wrapped by the app key.
    pub fn new_lens_key(&mut self, lens_id: &str) -> String {
        let key = Key::random();
        let wrapped = encrypt_lens_key(&key, &self.app_key);
        self.lens_keys.insert(lens_id.to_owned(), key);
        wrapped
    }

    pub fn encrypt_item(
        &self,
        lens_id: &str,
        plaintext: &SecretText,
    ) -> Result<String, SessionError> {
        encrypt_item(plaintext.expose(), self.lens_key(lens_id)?).map_err(|_| SessionError::Failed)
    }

    pub fn decrypt_item(&self, lens_id: &str, blob: &str) -> Result<SecretText, SessionError> {
        decrypt_item(blob, self.lens_key(lens_id)?)
            .map(SecretText::from)
            .map_err(|_| SessionError::Corrupt)
    }

    fn lens_key(&self, lens_id: &str) -> Result<&Key, SessionError> {
        self.lens_keys.get(lens_id).ok_or(SessionError::UnknownLens)
    }
}

/// Why opening the master key failed, as the UI hears it. Only a failed
/// authentication is a wrong password: a failed Argon2id run (such as too
/// little memory) must never make anyone think they forgot their password.
fn unlock_error(e: Error) -> SessionError {
    match e {
        Error::WrongKey => SessionError::WrongPassword,
        Error::Corrupt(_) => SessionError::Corrupt,
        _ => SessionError::Failed,
    }
}

/// Fails unless `blob` opens with `password` and `salt` to exactly `app_key`.
fn verify_master_key(
    app_key: &Key,
    blob: &str,
    salt: &str,
    password: &SecretText,
) -> Result<(), SessionError> {
    match decrypt_master_key(blob, password.expose(), salt) {
        Ok(opened) if opened.same_as(app_key) => Ok(()),
        _ => Err(SessionError::Failed),
    }
}

impl std::fmt::Debug for Unlocked {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "Unlocked({} Lens keys, redacted)", self.lens_keys.len())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn secret(text: &str) -> SecretText {
        SecretText::from(text.to_owned())
    }

    #[test]
    fn reports_only_a_failed_authentication_as_a_wrong_password() {
        use crate::format::FormatError;
        assert_eq!(unlock_error(Error::WrongKey), SessionError::WrongPassword);
        assert_eq!(
            unlock_error(Error::PasswordHashFailed),
            SessionError::Failed
        );
        assert_eq!(
            unlock_error(Error::Corrupt(FormatError::NotBase64)),
            SessionError::Corrupt
        );
        assert_eq!(unlock_error(Error::NotUtf8), SessionError::Failed);
    }

    // The check create() runs before handing out a new vault: only a blob that
    // opens to the very same app key passes.
    #[test]
    fn a_new_vault_is_only_handed_out_once_it_opens() {
        let app_key = Key::random();
        let (blob, salt) = encrypt_master_key(&app_key, "pw-123456").unwrap();
        assert_eq!(
            verify_master_key(&app_key, &blob, &salt, &secret("pw-123456")),
            Ok(())
        );

        // A blob the password can't open (as after a wrong derivation).
        assert_eq!(
            verify_master_key(&app_key, &blob, &salt, &secret("pw-1234567")),
            Err(SessionError::Failed)
        );
        // A blob that opens, but to some other key.
        let (other, other_salt) = encrypt_master_key(&Key::random(), "pw-123456").unwrap();
        assert_eq!(
            verify_master_key(&app_key, &other, &other_salt, &secret("pw-123456")),
            Err(SessionError::Failed)
        );
    }
}
