//! The vault file. It holds the same values the app kept in localStorage
//! (the v1 strings, byte for byte) under a small header:
//!
//! ```json
//! { "format": "still-vault", "formatVersion": 1, "migratedFrom": "localStorage",
//!   "data": { "still-encrypted-master-key": "...", "still-lenses": "[...]", ... } }
//! ```
//!
//! Every write is atomic: a new file is written beside the old one, flushed
//! to disk and renamed over it, so a crash leaves the old vault or the new one,
//! never a mix. The previous version is kept as `vault.json.bak`, refreshed by
//! copying so `vault.json` always exists. A file that can't be read is never
//! overwritten. On Unix the folder is 0700 and the files 0600.

use std::collections::BTreeMap;
use std::fs::{self, File, OpenOptions};
use std::io::{ErrorKind, Write};
use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};
use still_core::sodium;

pub const FILE_NAME: &str = "vault.json";
pub const BACKUP_NAME: &str = "vault.json.bak";
const FORMAT: &str = "still-vault";
const FORMAT_VERSION: u32 = 1;

/// Stored values by key, exactly as the app writes them.
pub type Values = BTreeMap<String, String>;

#[derive(Serialize, Deserialize, Debug, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
struct VaultFile {
    format: String,
    format_version: u32,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    migrated_from: Option<String>,
    data: Values,
}

/// What's on disk.
#[derive(Debug, PartialEq, Eq)]
pub enum Loaded {
    /// No vault file (and no backup): nothing has been stored yet.
    Nothing,
    Values(Values),
    /// The file is damaged or in an unknown format, or it's missing while
    /// its backup exists. Never written over.
    Unreadable,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum StoreError {
    /// The stored vault can't be read, so it won't be changed.
    Unreadable,
    /// An import found a vault file already there.
    Exists,
    /// Reading back what was just written gave something else.
    VerifyFailed,
    /// The disk refused (permissions, space, ...). Nothing was changed.
    Io,
}

impl StoreError {
    pub fn code(self) -> &'static str {
        match self {
            Self::Unreadable => "unreadable-data",
            Self::Exists => "exists",
            Self::VerifyFailed | Self::Io => "failed",
        }
    }
}

impl From<std::io::Error> for StoreError {
    fn from(_: std::io::Error) -> Self {
        Self::Io
    }
}

pub struct Store {
    dir: PathBuf,
}

impl Store {
    pub fn new(dir: PathBuf) -> Self {
        Self { dir }
    }

    fn file(&self) -> PathBuf {
        self.dir.join(FILE_NAME)
    }

    fn backup(&self) -> PathBuf {
        self.dir.join(BACKUP_NAME)
    }

    pub fn load(&self) -> Loaded {
        match fs::read(self.file()) {
            Ok(bytes) => match serde_json::from_slice::<VaultFile>(&bytes) {
                Ok(file) if file.format == FORMAT && file.format_version == FORMAT_VERSION => {
                    Loaded::Values(file.data)
                }
                _ => Loaded::Unreadable,
            },
            Err(e) if e.kind() == ErrorKind::NotFound => {
                if self.backup().exists() {
                    Loaded::Unreadable
                } else {
                    Loaded::Nothing
                }
            }
            Err(_) => Loaded::Unreadable,
        }
    }

    /// Applies `changes` (a value to set, or None to remove) in one atomic write.
    pub fn write(&self, changes: &BTreeMap<String, Option<String>>) -> Result<(), StoreError> {
        let (mut data, migrated_from) = match self.load() {
            Loaded::Nothing => (Values::new(), None),
            Loaded::Values(_) => {
                let file = self.read_file()?;
                (file.data, file.migrated_from)
            }
            Loaded::Unreadable => return Err(StoreError::Unreadable),
        };
        for (key, value) in changes {
            match value {
                Some(value) => data.insert(key.clone(), value.clone()),
                None => data.remove(key),
            };
        }
        self.save(&VaultFile {
            format: FORMAT.into(),
            format_version: FORMAT_VERSION,
            migrated_from,
            data,
        })
    }

    /// Creates the vault file from the values an older version kept in
    /// localStorage, unchanged. Refuses if a vault file (or its backup)
    /// already exists, and checks the file reads back exactly.
    pub fn import_legacy(&self, values: Values) -> Result<(), StoreError> {
        if self.file().exists() || self.backup().exists() {
            return Err(StoreError::Exists);
        }
        self.save(&VaultFile {
            format: FORMAT.into(),
            format_version: FORMAT_VERSION,
            migrated_from: Some("localStorage".into()),
            data: values.clone(),
        })?;
        match self.load() {
            Loaded::Values(stored) if stored == values => Ok(()),
            _ => Err(StoreError::VerifyFailed),
        }
    }

    fn read_file(&self) -> Result<VaultFile, StoreError> {
        let bytes = fs::read(self.file())?;
        serde_json::from_slice(&bytes).map_err(|_| StoreError::Unreadable)
    }

    fn save(&self, file: &VaultFile) -> Result<(), StoreError> {
        let mut bytes = serde_json::to_vec_pretty(file).map_err(|_| StoreError::Io)?;
        bytes.push(b'\n');
        create_private_dir(&self.dir)?;
        if self.file().exists() {
            // Refresh the backup by copying, so vault.json never goes missing.
            let previous = fs::read(self.file())?;
            write_atomically(&self.dir, &self.backup(), &previous)?;
        }
        write_atomically(&self.dir, &self.file(), &bytes)
    }
}

fn create_private_dir(dir: &Path) -> std::io::Result<()> {
    let mut builder = fs::DirBuilder::new();
    builder.recursive(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::DirBuilderExt;
        builder.mode(0o700);
    }
    builder.create(dir)
}

/// Writes `bytes` to a new file beside `target`, flushes it, renames it over
/// `target` and flushes the folder. On failure the temporary file is removed
/// and `target` is unchanged.
fn write_atomically(dir: &Path, target: &Path, bytes: &[u8]) -> Result<(), StoreError> {
    let mut suffix = [0u8; 8];
    sodium::random_bytes(&mut suffix);
    let name = target
        .file_name()
        .and_then(|n| n.to_str())
        .unwrap_or("vault");
    let temp = dir.join(format!(
        ".{name}.{}.tmp",
        suffix
            .iter()
            .map(|b| format!("{b:02x}"))
            .collect::<String>()
    ));
    let result = (|| {
        let mut options = OpenOptions::new();
        options.write(true).create_new(true);
        #[cfg(unix)]
        {
            use std::os::unix::fs::OpenOptionsExt;
            options.mode(0o600);
        }
        let mut file = options.open(&temp)?;
        file.write_all(bytes)?;
        file.sync_all()?;
        drop(file);
        fs::rename(&temp, target)?;
        sync_dir(dir)
    })();
    if result.is_err() {
        let _ = fs::remove_file(&temp);
    }
    result.map_err(StoreError::from)
}

#[cfg(unix)]
fn sync_dir(dir: &Path) -> std::io::Result<()> {
    File::open(dir)?.sync_all()
}

#[cfg(not(unix))]
fn sync_dir(_dir: &Path) -> std::io::Result<()> {
    // Windows can't open a folder to flush it; the rename itself is atomic.
    Ok(())
}

/// The store as the app uses it: the vault folder, held by this copy of
/// Still alone. A second copy sees `already_open` and stores nothing.
pub struct AppStore {
    store: std::sync::Mutex<Store>,
    // Held for the life of the process; the OS releases it if Still crashes.
    _lock: Option<File>,
    pub already_open: bool,
}

impl AppStore {
    pub fn open(dir: PathBuf) -> Self {
        let lock = create_private_dir(&dir)
            .and_then(|()| {
                OpenOptions::new()
                    .create(true)
                    .truncate(false)
                    .write(true)
                    .open(dir.join(".lock"))
            })
            .ok();
        let held = lock.as_ref().is_some_and(|f| f.try_lock().is_ok());
        Self {
            store: std::sync::Mutex::new(Store::new(dir)),
            _lock: if held { lock } else { None },
            already_open: !held,
        }
    }

    pub fn store(&self) -> std::sync::MutexGuard<'_, Store> {
        self.store.lock().unwrap_or_else(|p| p.into_inner())
    }
}

/// Where the vault lives: the app-data folder, or a `dev` folder inside it
/// for debug builds, which share the identifier (and so the folder) with
/// release builds.
pub fn vault_dir(app_data_dir: PathBuf) -> PathBuf {
    if cfg!(debug_assertions) {
        app_data_dir.join("dev")
    } else {
        app_data_dir
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// A fresh folder under the system temp dir, removed when dropped.
    struct TempDir(PathBuf);

    impl TempDir {
        fn new() -> Self {
            let mut id = [0u8; 8];
            sodium::random_bytes(&mut id);
            let hex: String = id.iter().map(|b| format!("{b:02x}")).collect();
            Self(std::env::temp_dir().join(format!("still-store-test-{hex}")))
        }
        fn store(&self) -> Store {
            Store::new(self.0.join("com.still.app"))
        }
    }

    impl Drop for TempDir {
        fn drop(&mut self) {
            #[cfg(unix)]
            {
                use std::os::unix::fs::PermissionsExt;
                let _ = fs::set_permissions(
                    self.0.join("com.still.app"),
                    fs::Permissions::from_mode(0o700),
                );
            }
            let _ = fs::remove_dir_all(&self.0);
        }
    }

    fn set(pairs: &[(&str, Option<&str>)]) -> BTreeMap<String, Option<String>> {
        pairs
            .iter()
            .map(|(k, v)| (k.to_string(), v.map(str::to_string)))
            .collect()
    }

    fn values(pairs: &[(&str, &str)]) -> Values {
        pairs
            .iter()
            .map(|(k, v)| (k.to_string(), v.to_string()))
            .collect()
    }

    /// The five localStorage values of the vault exported from a release build.
    fn real_vault() -> Values {
        let json = include_str!("../../fixtures/vault-v1-real/vault.json");
        serde_json::from_str(json).unwrap()
    }

    #[test]
    fn starts_empty_and_round_trips_changes_in_one_write() {
        let tmp = TempDir::new();
        let store = tmp.store();
        assert_eq!(store.load(), Loaded::Nothing);

        store
            .write(&set(&[("a", Some("1")), ("b", Some("[\"x\"]"))]))
            .unwrap();
        store.write(&set(&[("a", None), ("c", Some("3"))])).unwrap();
        assert_eq!(
            store.load(),
            Loaded::Values(values(&[("b", "[\"x\"]"), ("c", "3")]))
        );
    }

    #[test]
    fn keeps_the_previous_version_as_a_backup() {
        let tmp = TempDir::new();
        let store = tmp.store();
        store.write(&set(&[("a", Some("1"))])).unwrap();
        store.write(&set(&[("a", Some("2"))])).unwrap();
        let backup: VaultFile = serde_json::from_slice(&fs::read(store.backup()).unwrap()).unwrap();
        assert_eq!(backup.data, values(&[("a", "1")]));
    }

    #[cfg(unix)]
    #[test]
    fn is_private_to_the_user() {
        use std::os::unix::fs::PermissionsExt;
        let tmp = TempDir::new();
        let store = tmp.store();
        store.write(&set(&[("a", Some("1"))])).unwrap();
        store.write(&set(&[("a", Some("2"))])).unwrap();
        let mode = |p: PathBuf| fs::metadata(p).unwrap().permissions().mode() & 0o777;
        assert_eq!(mode(store.dir.clone()), 0o700);
        assert_eq!(mode(store.file()), 0o600);
        assert_eq!(mode(store.backup()), 0o600);
    }

    #[cfg(unix)]
    #[test]
    fn a_failed_write_changes_nothing_and_leaves_no_temporary_file() {
        use std::os::unix::fs::PermissionsExt;
        let tmp = TempDir::new();
        let store = tmp.store();
        store.write(&set(&[("a", Some("1"))])).unwrap();
        let before = fs::read(store.file()).unwrap();
        // The folder refuses new files, as a full or read-only disk would.
        fs::set_permissions(&store.dir, fs::Permissions::from_mode(0o500)).unwrap();
        assert_eq!(store.write(&set(&[("a", Some("2"))])), Err(StoreError::Io));
        fs::set_permissions(&store.dir, fs::Permissions::from_mode(0o700)).unwrap();
        assert_eq!(fs::read(store.file()).unwrap(), before);
        let leftovers: Vec<_> = fs::read_dir(&store.dir)
            .unwrap()
            .filter_map(|e| e.ok())
            .filter(|e| e.file_name().to_string_lossy().ends_with(".tmp"))
            .collect();
        assert!(leftovers.is_empty());
    }

    #[test]
    fn never_writes_over_a_damaged_file() {
        let tmp = TempDir::new();
        let store = tmp.store();
        create_private_dir(&store.dir).unwrap();
        for damaged in [
            &b"{not json"[..],
            br#"{"format":"still-vault","formatVersion":2,"data":{}}"#,
            br#"{"format":"other","formatVersion":1,"data":{}}"#,
        ] {
            fs::write(store.file(), damaged).unwrap();
            assert_eq!(store.load(), Loaded::Unreadable);
            assert_eq!(
                store.write(&set(&[("a", Some("1"))])),
                Err(StoreError::Unreadable)
            );
            assert_eq!(fs::read(store.file()).unwrap(), damaged);
        }
    }

    #[test]
    fn a_missing_file_beside_its_backup_is_damage_not_a_new_install() {
        let tmp = TempDir::new();
        let store = tmp.store();
        store.write(&set(&[("a", Some("1"))])).unwrap();
        store.write(&set(&[("a", Some("2"))])).unwrap();
        fs::remove_file(store.file()).unwrap();
        assert_eq!(store.load(), Loaded::Unreadable);
        assert_eq!(
            store.write(&set(&[("a", Some("3"))])),
            Err(StoreError::Unreadable)
        );
        assert_eq!(store.import_legacy(values(&[])), Err(StoreError::Exists));
    }

    #[test]
    fn imports_the_real_vault_byte_for_byte_and_it_opens() {
        let tmp = TempDir::new();
        let store = tmp.store();
        let legacy = real_vault();
        store.import_legacy(legacy.clone()).unwrap();
        let Loaded::Values(stored) = store.load() else {
            panic!("the imported vault loads")
        };
        assert_eq!(stored, legacy);
        let file: VaultFile = serde_json::from_slice(&fs::read(store.file()).unwrap()).unwrap();
        assert_eq!(file.migrated_from.as_deref(), Some("localStorage"));

        // The imported values open with the real password.
        let lenses: serde_json::Value = serde_json::from_str(&stored["still-lenses"]).unwrap();
        let wrapped: Vec<still_core::session::WrappedLensKey<'_>> = lenses
            .as_array()
            .unwrap()
            .iter()
            .map(|l| still_core::session::WrappedLensKey {
                id: l["id"].as_str().unwrap(),
                encrypted_master_key: l["encryptedMasterKey"].as_str().unwrap(),
            })
            .collect();
        let (_, opened) = still_core::session::Unlocked::open(
            &stored["still-encrypted-master-key"],
            &stored["still-salt"],
            &still_core::session::SecretText::from("throwaway-vault-202".to_owned()),
            &wrapped,
        )
        .unwrap();
        assert!(opened.iter().all(|&o| o));
    }

    #[test]
    fn never_imports_over_an_existing_vault_file() {
        let tmp = TempDir::new();
        let store = tmp.store();
        store.write(&set(&[("a", Some("mine"))])).unwrap();
        assert_eq!(
            store.import_legacy(values(&[("a", "old")])),
            Err(StoreError::Exists)
        );
        assert_eq!(store.load(), Loaded::Values(values(&[("a", "mine")])));
    }

    #[test]
    fn only_one_copy_of_still_holds_the_vault() {
        let tmp = TempDir::new();
        let dir = tmp.0.join("com.still.app");
        let first = AppStore::open(dir.clone());
        assert!(!first.already_open);
        let second = AppStore::open(dir.clone());
        assert!(second.already_open);
        drop(first);
        drop(second);
        // Once the first copy has gone, the next one gets the vault.
        assert!(!AppStore::open(dir).already_open);
    }

    #[test]
    fn debug_builds_keep_their_vault_apart() {
        let dir = vault_dir(PathBuf::from("/data/com.still.app"));
        if cfg!(debug_assertions) {
            assert_eq!(dir, PathBuf::from("/data/com.still.app/dev"));
        } else {
            assert_eq!(dir, PathBuf::from("/data/com.still.app"));
        }
    }

    #[test]
    fn a_leftover_temporary_file_from_a_crash_is_ignored() {
        let tmp = TempDir::new();
        let store = tmp.store();
        store.write(&set(&[("a", Some("1"))])).unwrap();
        fs::write(store.dir.join(".vault.json.0011223344556677.tmp"), b"half").unwrap();
        assert_eq!(store.load(), Loaded::Values(values(&[("a", "1")])));
        store.write(&set(&[("a", Some("2"))])).unwrap();
        assert_eq!(store.load(), Loaded::Values(values(&[("a", "2")])));
    }
}
