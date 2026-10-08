//! The app's vault: the vault backend (still-core's `vault::backend`) over
//! the vault file, with the keys of the unlocked vault, held in Rust for the
//! life of the process. The webview never sees a key or an encrypted value;
//! it gets ids and metadata, and a value only when it reveals one.

use std::collections::BTreeMap;
use std::sync::{Arc, Mutex, MutexGuard};

use serde::{Serialize, Serializer};
use serde_json::{json, Value};
use still_core::session::{SecretText, Unlocked};
use still_core::vault::backend::{self, Backend, Status, Storage, StorageError};
use tauri::Manager;

use crate::store::{AppStore, Loaded};

/// Registers the (locked) vault with the app.
pub fn init(app: &tauri::App, store: Arc<AppStore>) {
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

/// A revealed value on its way to the webview. Zeroed once it's been sent.
pub struct Revealed(pub SecretText);

impl Serialize for Revealed {
    fn serialize<S: Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
        serializer.serialize_str(self.0.expose())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn secret(text: &str) -> SecretText {
        SecretText::from(text.to_owned())
    }

    fn json<T: Serialize>(value: &T) -> String {
        serde_json::to_string(value).unwrap()
    }

    #[test]
    fn sends_values_as_plain_strings() {
        assert_eq!(json(&Revealed(secret("ünï 🔐"))), r#""ünï 🔐""#);
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
