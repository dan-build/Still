//! The app's vault session: the keys of the unlocked vault, held in Rust
//! for the life of the process. The webview never sees a key; it gets
//! encrypted blobs, and a plaintext only when it reveals an item.

use std::sync::{Mutex, MutexGuard};

use serde::{Serialize, Serializer};
use still_core::session::{SecretText, SessionError, Unlocked, WrappedLensKey};
use tauri::Manager;

/// Registers the (locked) session with the app.
pub fn init(app: &tauri::App) {
    app.manage(VaultSession::default());
}

/// A failure the UI may see: a fixed code, never anything secret.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct VaultError(pub SessionError);

impl Serialize for VaultError {
    fn serialize<S: Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
        serializer.serialize_str(self.0.code())
    }
}

impl From<SessionError> for VaultError {
    fn from(e: SessionError) -> Self {
        Self(e)
    }
}

/// A revealed value on its way to the webview. Zeroed once it's been sent.
pub struct Revealed(pub SecretText);

impl Serialize for Revealed {
    fn serialize<S: Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
        serializer.serialize_str(self.0.expose())
    }
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CreatedVault {
    pub encrypted_master_key: String,
    pub salt: String,
}

#[derive(Default)]
pub struct VaultSession(Mutex<Option<Unlocked>>);

impl VaultSession {
    // A panic can't leave the keys half-changed, so a poisoned lock is still usable.
    fn keys(&self) -> MutexGuard<'_, Option<Unlocked>> {
        self.0
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
    }

    /// Takes over a vault opened elsewhere (Argon2id runs before this, unlocked).
    pub fn install(&self, unlocked: Unlocked) {
        *self.keys() = Some(unlocked);
    }

    /// Drops every key; each one zeroes itself.
    pub fn lock(&self) {
        self.keys().take();
    }

    #[cfg(test)]
    pub fn is_unlocked(&self) -> bool {
        self.keys().is_some()
    }

    pub fn new_lens_key(&self, lens_id: &str) -> Result<String, VaultError> {
        let mut keys = self.keys();
        let unlocked = keys.as_mut().ok_or(SessionError::Locked)?;
        Ok(unlocked.new_lens_key(lens_id))
    }

    pub fn encrypt_item(
        &self,
        lens_id: &str,
        plaintext: &SecretText,
    ) -> Result<String, VaultError> {
        let keys = self.keys();
        let unlocked = keys.as_ref().ok_or(SessionError::Locked)?;
        Ok(unlocked.encrypt_item(lens_id, plaintext)?)
    }

    pub fn decrypt_item(&self, lens_id: &str, blob: &str) -> Result<Revealed, VaultError> {
        let keys = self.keys();
        let unlocked = keys.as_ref().ok_or(SessionError::Locked)?;
        Ok(Revealed(unlocked.decrypt_item(lens_id, blob)?))
    }
}

/// Opens a vault without holding the session lock (Argon2id takes seconds).
pub fn open(
    encrypted_master_key: &str,
    salt: &str,
    password: &SecretText,
    lenses: &[(String, String)],
) -> Result<(Unlocked, Vec<bool>), VaultError> {
    let wrapped: Vec<WrappedLensKey<'_>> = lenses
        .iter()
        .map(|(id, key)| WrappedLensKey {
            id,
            encrypted_master_key: key,
        })
        .collect();
    Ok(Unlocked::open(
        encrypted_master_key,
        salt,
        password,
        &wrapped,
    )?)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn secret(text: &str) -> SecretText {
        SecretText::from(text.to_owned())
    }

    #[test]
    fn refuses_everything_while_locked() {
        let session = VaultSession::default();
        assert!(!session.is_unlocked());
        let locked = Err(VaultError(SessionError::Locked));
        assert_eq!(session.new_lens_key("a"), locked);
        assert_eq!(session.encrypt_item("a", &secret("v")), locked);
        assert_eq!(
            session.decrypt_item("a", "blob").err(),
            Some(VaultError(SessionError::Locked))
        );
    }

    #[test]
    fn keeps_keys_until_lock_then_refuses() {
        let session = VaultSession::default();
        let (unlocked, blob, salt) = Unlocked::create(&secret("pw-123456")).unwrap();
        session.install(unlocked);
        let wrapped = session.new_lens_key("a").unwrap();
        let item = session
            .encrypt_item("a", &secret("  exact\nvalue "))
            .unwrap();
        assert_eq!(
            session.decrypt_item("a", &item).unwrap().0.expose(),
            "  exact\nvalue "
        );
        assert_eq!(
            session.decrypt_item("b", &item).err(),
            Some(VaultError(SessionError::UnknownLens))
        );

        session.lock();
        assert!(!session.is_unlocked());
        assert_eq!(
            session.decrypt_item("a", &item).err(),
            Some(VaultError(SessionError::Locked))
        );

        // The stored blobs still open after a fresh unlock.
        let (reopened, opened) =
            open(&blob, &salt, &secret("pw-123456"), &[("a".into(), wrapped)]).unwrap();
        assert_eq!(opened, vec![true]);
        session.install(reopened);
        assert_eq!(
            session.decrypt_item("a", &item).unwrap().0.expose(),
            "  exact\nvalue "
        );
    }

    fn json<T: Serialize>(value: &T) -> String {
        serde_json::to_string(value).unwrap()
    }

    #[test]
    fn sends_errors_as_codes_and_values_as_plain_strings() {
        assert_eq!(
            json(&VaultError(SessionError::WrongPassword)),
            r#""wrong-password""#
        );
        assert_eq!(json(&Revealed(secret("ünï 🔐"))), r#""ünï 🔐""#);
        let created = CreatedVault {
            encrypted_master_key: "k".into(),
            salt: "s".into(),
        };
        assert_eq!(json(&created), r#"{"encryptedMasterKey":"k","salt":"s"}"#);
    }
}
