//! The app's vault: the vault backend (still-core's `vault::backend`) over
//! the vault file, with the keys of the unlocked vault, held in Rust for the
//! life of the process. The webview never sees a key or an encrypted value;
//! it gets ids and metadata, and a value only when it reveals one.
//!
//! `VaultSession` is the older, key-only session the page still uses until
//! it moves to the backend's commands.

use std::collections::BTreeMap;
use std::sync::{Arc, Mutex, MutexGuard};

use serde::{Serialize, Serializer};
use serde_json::{json, Value};
use still_core::session::{SecretText, SessionError, Unlocked, WrappedLensKey};
use still_core::vault::backend::{self, Backend, Status, Storage, StorageError};
use tauri::Manager;

use crate::store::{AppStore, Loaded};

/// Registers the (locked) session and vault with the app.
pub fn init(app: &tauri::App, store: Arc<AppStore>) {
    app.manage(VaultSession::default());
    app.manage(Vault::new(FileStorage(store)));
}

/// The vault file as the backend's storage. Every read loads the file, so
/// the backend always sees what is on disk. While another copy of Still
/// holds the vault, nothing is read and every write fails.
pub struct FileStorage(pub Arc<AppStore>);

impl FileStorage {
    fn values(&self) -> BTreeMap<String, String> {
        if self.0.already_open {
            return BTreeMap::new();
        }
        match self.0.store().load() {
            Loaded::Values(values) => values,
            Loaded::Nothing | Loaded::Unreadable => BTreeMap::new(),
        }
    }
}

impl Storage for FileStorage {
    fn get(&self, key: &str) -> Option<String> {
        self.values().remove(key)
    }

    fn keys(&self) -> Vec<String> {
        self.values().into_keys().collect()
    }

    fn write(&mut self, changes: &[(String, Option<String>)]) -> Result<(), StorageError> {
        if self.0.already_open {
            return Err(StorageError);
        }
        let changes: BTreeMap<String, Option<String>> = changes.iter().cloned().collect();
        self.0.store().write(&changes).map_err(|_| StorageError)
    }
}

pub type AppBackend = Backend<FileStorage, Unlocked>;

/// The vault backend, one operation at a time: a Lock waits for a change
/// already under way. Creating and unlocking release it for Argon2id.
pub struct Vault(Mutex<AppBackend>);

impl Vault {
    pub fn new(storage: FileStorage) -> Self {
        Self(Mutex::new(Backend::new(storage, backend::system_clock())))
    }

    // A panic mid-change leaves the backend as it was before that change
    // (changes apply only after their write), so a poisoned lock is usable.
    pub fn backend(&self) -> MutexGuard<'_, AppBackend> {
        self.0
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
    }
}

/// What the page sees after every vault command: the status and the view.
pub fn state(backend: &AppBackend) -> Value {
    let status = backend.status();
    let view = match status {
        Status::Unlocked => backend.view().to_json(),
        _ => json!({ "lenses": [], "bin": [], "unreadable": 0 }),
    };
    json!({ "status": status.code(), "view": view })
}

/// A refused vault command, sent as its code.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct CommandError(pub &'static str);

impl Serialize for CommandError {
    fn serialize<S: Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
        serializer.serialize_str(self.0)
    }
}

impl From<backend::VaultError> for CommandError {
    fn from(e: backend::VaultError) -> Self {
        Self(e.code())
    }
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

    /// A fresh vault folder under the system temp dir, removed when dropped.
    struct TempDir(std::path::PathBuf);

    impl TempDir {
        fn new() -> Self {
            let mut id = [0u8; 8];
            still_core::sodium::random_bytes(&mut id);
            let hex: String = id.iter().map(|b| format!("{b:02x}")).collect();
            Self(std::env::temp_dir().join(format!("still-vault-test-{hex}")))
        }
    }

    impl Drop for TempDir {
        fn drop(&mut self) {
            let _ = std::fs::remove_dir_all(&self.0);
        }
    }

    #[test]
    fn keeps_the_vault_in_the_file() {
        let dir = TempDir::new();
        let store = Arc::new(AppStore::open(dir.0.join("vault")));
        let vault = Vault::new(FileStorage(store.clone()));
        assert_eq!(state(&vault.backend())["status"], "empty");

        let mut backend = vault.backend();
        backend.create(&secret("pw-123456")).unwrap();
        let lens = backend.create_lens("Work").unwrap();
        backend
            .add_item(&lens, "Email", "password", &secret(" exact "))
            .unwrap();
        let shown = state(&backend);
        assert_eq!(shown["status"], "unlocked");
        assert_eq!(shown["view"]["lenses"][0]["name"], "Work");
        assert!(!shown.to_string().contains("encrypted"));
        backend.lock();
        assert_eq!(state(&backend)["view"]["lenses"], json!([]));
        drop(backend);

        // A new backend on the same file (as after a restart) opens it.
        let Loaded::Values(values) = store.store().load() else {
            panic!("the vault file exists");
        };
        assert!(values["still-lenses"].contains("\"name\":\"Work\""));
        let reopened = Vault::new(FileStorage(store));
        let mut backend = reopened.backend();
        backend.unlock(&secret("pw-123456")).unwrap();
        let item = backend.view().lenses[0]["items"][0]["id"]
            .as_str()
            .unwrap()
            .to_owned();
        assert_eq!(
            backend.reveal_item(&lens, &item).unwrap().expose(),
            " exact "
        );
    }

    #[test]
    fn reads_and_writes_nothing_while_another_copy_holds_the_vault() {
        let dir = TempDir::new();
        let first = Arc::new(AppStore::open(dir.0.join("vault")));
        let second = Arc::new(AppStore::open(dir.0.join("vault")));
        assert!(second.already_open);
        Vault::new(FileStorage(first))
            .backend()
            .create(&secret("pw"))
            .unwrap();

        let vault = Vault::new(FileStorage(second));
        let mut backend = vault.backend();
        assert_eq!(state(&backend)["status"], "empty");
        assert_eq!(
            backend.create(&secret("other")).err().map(|e| e.code()),
            Some("storage-failed")
        );
    }

    #[test]
    fn sends_vault_errors_as_codes() {
        assert_eq!(
            json(&CommandError::from(backend::VaultError::UnknownLens)),
            r#""unknown-lens""#
        );
    }
}
