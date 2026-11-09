//! The app's vault: the vault backend (still-core's `vault::backend`) over
//! the vault file, with the keys of the unlocked vault, held in Rust for the
//! life of the process. The webview never sees a key or an encrypted value;
//! it gets ids and metadata, and a value only when it reveals one.

use std::collections::BTreeMap;
use std::sync::{Arc, Mutex, MutexGuard};

use serde::{Serialize, Serializer};
use serde_json::{json, Value};
use still_core::session::{SecretText, Unlocked};
use still_core::v2;
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
            Loaded::Nothing | Loaded::V2(_) | Loaded::Unreadable => BTreeMap::new(),
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

    fn v2(&self) -> Option<v2::File> {
        if self.0.already_open {
            return None;
        }
        match self.0.store().load() {
            Loaded::V2(file) => Some(*file),
            _ => None,
        }
    }

    fn write_v2(&mut self, file: &v2::File) -> Result<(), StorageError> {
        if self.0.already_open {
            return Err(StorageError);
        }
        self.0.store().write_v2(file).map_err(|_| StorageError)
    }

    /// New vaults are created in format v2, unless a v1 file is already
    /// there (set-aside copies, say): then in v1, converted at its first
    /// unlock, which keeps that file as it is.
    fn creates_v2(&self) -> bool {
        matches!(self.0.store().load(), Loaded::Nothing | Loaded::V2(_))
    }

    fn converts_v1(&self) -> bool {
        true
    }

    fn mark_damaged(&mut self) {
        self.0.store().mark_damaged_body();
    }

    fn unreadable(&self) -> bool {
        !self.0.already_open && self.0.store().load() == Loaded::Unreadable
    }

    fn write_rekeyed_v2(&mut self, file: &v2::File) -> Result<Vec<String>, StorageError> {
        self.0
            .store()
            .write_rekeyed_v2(file)
            .map_err(|_| StorageError)
    }

    fn convert_to_v2(
        &mut self,
        file: &v2::File,
        expected: &[(String, Option<String>)],
    ) -> Result<String, StorageError> {
        if self.0.already_open {
            return Err(StorageError);
        }
        self.0
            .store()
            .convert_to_v2(file, expected)
            .map_err(|_| StorageError)
    }
}

pub type AppBackend = Backend<FileStorage, Unlocked>;

/// The vault backend, one operation at a time: a Lock waits for a change
/// already under way. Creating and unlocking release it for Argon2id.
pub struct Vault(Mutex<AppBackend>);

/// A backup chosen for restoring (restore_choose), and whether its password
/// has opened it (restore_check). restore_confirm needs both; choosing
/// another replaces it.
#[derive(Default)]
pub struct PendingRestore(Mutex<Option<ChosenBackup>>);

pub struct ChosenBackup {
    pub file: v2::File,
    pub checked: bool,
}

impl PendingRestore {
    pub fn get(&self) -> MutexGuard<'_, Option<ChosenBackup>> {
        self.0.lock().unwrap_or_else(|p| p.into_inner())
    }
}

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

        // The file is v2, and nothing in it is readable.
        let Loaded::V2(_) = store.store().load() else {
            panic!("a new vault is saved in v2");
        };
        let text = std::fs::read_to_string(dir.0.join("vault").join("vault.json")).unwrap();
        assert!(!text.contains("Work") && !text.contains("Email"));

        // A new backend on the same file (as after a restart) opens it.
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

    // The real v2 vault a release build wrote (fixtures/vault-v2-real),
    // through the vault file as the app uses it: start-up trusts it (first
    // record), it unlocks to every secret, takes a change in v2, and opens
    // again after a restart, with nothing else lost.
    #[test]
    fn opens_and_changes_the_real_v2_vault_from_a_release_build() {
        let dir = TempDir::new();
        let folder = dir.0.join("vault");
        std::fs::create_dir_all(&folder).unwrap();
        std::fs::write(
            folder.join("vault.json"),
            include_str!("../../fixtures/vault-v2-real/vault.json"),
        )
        .unwrap();
        let expected: Value =
            serde_json::from_str(include_str!("../../fixtures/vault-v2-real/expected.json"))
                .unwrap();
        let password = secret(expected["password"].as_str().unwrap());
        let reveal_all = |backend: &mut AppBackend| {
            let mut count = 0;
            for (lens_id, lens) in expected["lenses"].as_object().unwrap() {
                for (item_id, item) in lens["items"].as_object().unwrap() {
                    let value = backend.reveal_item(lens_id, item_id).unwrap();
                    assert_eq!(value.expose(), item["value"].as_str().unwrap());
                    count += 1;
                }
            }
            count
        };

        let store = Arc::new(AppStore::open(folder.clone()));
        let started = crate::startup::open(&store, Default::default(), None, None, 0);
        assert_eq!(started.to_json(), json!({ "kind": "ready" }));
        let vault = Vault::new(FileStorage(store.clone()));
        let mut backend = vault.backend();
        backend.unlock(&password).unwrap();
        assert_eq!(
            backend.take_notice(),
            None,
            "already v2: nothing to convert"
        );
        assert_eq!(state(&backend)["view"]["lenses"][0]["name"], "Export Test");
        assert_eq!(reveal_all(&mut backend), 7);

        let lens = "muk8tmfq";
        backend
            .add_item(lens, "fixture-check", "password", &secret("added ✓"))
            .unwrap();
        drop(backend);
        drop(vault);
        let Loaded::V2(_) = store.store().load() else {
            panic!("saved in v2");
        };
        assert_eq!(store.store().check_file(), crate::store::FileCheck::Matches);

        let reopened = Vault::new(FileStorage(store));
        let mut backend = reopened.backend();
        backend.unlock(&password).unwrap();
        assert_eq!(reveal_all(&mut backend), 7);
        let items = backend.view().lenses[0]["items"].clone();
        let added = items
            .as_array()
            .unwrap()
            .iter()
            .find(|item| item["label"] == "fixture-check")
            .unwrap()["id"]
            .as_str()
            .unwrap()
            .to_owned();
        assert_eq!(
            backend.reveal_item(lens, &added).unwrap().expose(),
            "added ✓"
        );
    }

    /// A v2 vault with two saves, so `.bak` is a good v2 copy, and the vault
    /// file then changed so it still passes every header check but its body
    /// doesn't open: a consistent edit, or a bug.
    fn vault_with_a_damaged_body(dir: &TempDir) -> Arc<AppStore> {
        let store = Arc::new(AppStore::open(dir.0.join("vault")));
        {
            let vault = Vault::new(FileStorage(store.clone()));
            let mut backend = vault.backend();
            backend.create(&secret("pw-123456")).unwrap();
            backend.create_lens("First").unwrap();
            backend.create_lens("Second").unwrap();
        }
        let path = dir.0.join("vault").join("vault.json");
        let mut file = v2::File::parse(&std::fs::read_to_string(&path).unwrap()).unwrap();
        let last = file.body.len() - 1;
        file.body[last] ^= 1;
        std::fs::write(&path, file.to_json()).unwrap();
        store
    }

    // Header damage gets "use the kept copy" at start-up. A body that doesn't
    // open is only found by unlocking, with the right password; then the
    // same offer is made, for that file only.
    #[test]
    fn offers_the_kept_copy_when_an_unlock_finds_the_body_damaged() {
        let dir = TempDir::new();
        let store = vault_with_a_damaged_body(&dir);
        assert_eq!(store.store().restore_source(), None, "not before unlocking");
        let vault = Vault::new(FileStorage(store.clone()));
        assert_eq!(
            vault.backend().unlock(&secret("pw-123456")),
            Err(backend::UnlockFailure::UnreadableData)
        );
        assert_eq!(
            store.store().restore_source(),
            Some(crate::store::Restore::Backup),
            "no kept copy offered"
        );

        // Putting it back keeps the damaged file, and the vault opens as it
        // was one save earlier.
        let damaged = std::fs::read(dir.0.join("vault").join("vault.json")).unwrap();
        assert_eq!(
            crate::startup::restore_kept(&store).to_json()["notice"],
            "restored"
        );
        assert_eq!(
            std::fs::read(dir.0.join("vault").join("vault-unreadable.json")).unwrap(),
            damaged
        );
        let reopened = Vault::new(FileStorage(store));
        let mut backend = reopened.backend();
        backend.unlock(&secret("pw-123456")).unwrap();
        let names: Vec<_> = backend
            .view()
            .lenses
            .iter()
            .map(|l| l["name"].clone())
            .collect();
        assert_eq!(names, [json!("First")]);
    }

    #[test]
    fn offers_no_kept_copy_after_a_wrong_password() {
        let dir = TempDir::new();
        let store = vault_with_a_damaged_body(&dir);
        let vault = Vault::new(FileStorage(store.clone()));
        // A wrong password proves nothing about the file.
        assert_eq!(
            vault.backend().unlock(&secret("not-the-password")),
            Err(backend::UnlockFailure::WrongPassword)
        );
        assert_eq!(store.store().restore_source(), None);
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
