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
use still_core::v2;

pub const FILE_NAME: &str = "vault.json";
pub const BACKUP_NAME: &str = "vault.json.bak";
const FORMAT: &str = "still-vault";
const FORMAT_VERSION: u32 = 1;
const FORMAT_VERSION_1: u64 = FORMAT_VERSION as u64;

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

/// What `Store::restore` puts back.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Restore {
    /// `vault.json.bak`, a readable v2 vault.
    Backup,
    /// The v1 file a conversion kept.
    KeptV1(PathBuf),
}

/// What's on disk.
#[derive(Debug, PartialEq, Eq)]
pub enum Loaded {
    /// No vault file (and no backup): nothing has been stored yet.
    Nothing,
    Values(Values),
    /// A vault in format v2 (docs/vault-format-v2.md), read strictly.
    V2(Box<v2::File>),
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
    /// A write for one format while the file is in the other (a v2 vault
    /// never takes v1 values; only the conversion writes v2 over v1).
    OtherFormat,
    /// The disk refused (permissions, space, ...). Nothing was changed.
    Io,
}

impl From<std::io::Error> for StoreError {
    fn from(_: std::io::Error) -> Self {
        Self::Io
    }
}

pub struct Store {
    dir: PathBuf,
    /// SHA-256 of a v2 vault file whose body an unlock found doesn't open.
    /// Only that exact file may be restored over (see `restore_source`).
    damaged_body: Option<[u8; 32]>,
}

impl Store {
    pub fn new(dir: PathBuf) -> Self {
        Self {
            dir,
            damaged_body: None,
        }
    }

    /// An unlock found that the vault file's v2 body doesn't open (with the
    /// right password). Remembers exactly that file, so `restore_source` can
    /// offer a kept copy over it, and over nothing else.
    pub fn mark_damaged_body(&mut self) {
        self.damaged_body = fs::read(self.file())
            .ok()
            .filter(|bytes| matches!(read_vault(bytes), Loaded::V2(_)))
            .map(|bytes| sodium::sha256(&bytes));
    }

    fn file(&self) -> PathBuf {
        self.dir.join(FILE_NAME)
    }

    fn backup(&self) -> PathBuf {
        self.dir.join(BACKUP_NAME)
    }

    pub fn load(&self) -> Loaded {
        match fs::read(self.file()) {
            Ok(bytes) => read_vault(&bytes),
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
            Loaded::V2(_) => return Err(StoreError::OtherFormat),
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

    /// Replaces the vault with this v2 file in one atomic write (the
    /// previous file kept as the backup). Only a new vault or a v2 one: a v1
    /// vault changes to v2 only through the conversion, which keeps it.
    pub fn write_v2(&self, file: &v2::File) -> Result<(), StoreError> {
        match self.load() {
            Loaded::Nothing | Loaded::V2(_) => self.save_bytes(file.to_json().as_bytes()),
            Loaded::Values(_) => Err(StoreError::OtherFormat),
            Loaded::Unreadable => Err(StoreError::Unreadable),
        }
    }

    /// Converts the v1 vault to this v2 file (docs/vault-format-v2.md,
    /// "Converting from v1"), keeping the v1 file as `vault-v1.json` (or
    /// `vault-v1-2.json`, ... if a different one is there); Still never
    /// writes over or deletes a kept file. Refuses unless the file is still
    /// v1 and every value in `expected` is still exactly as read before the
    /// password step (a missing value still missing). Keeps the v1 file's
    /// bytes first, crash-safe; then writes v2 atomically and reads it back,
    /// putting the v1 file back if it doesn't read back exactly. Returns the
    /// kept copy's file name.
    pub fn convert_to_v2(
        &self,
        file: &v2::File,
        expected: &[(String, Option<String>)],
    ) -> Result<String, StoreError> {
        let original = fs::read(self.file())?;
        let Loaded::Values(values) = read_vault(&original) else {
            return Err(StoreError::OtherFormat);
        };
        if expected
            .iter()
            .any(|(key, value)| values.get(key) != value.as_ref())
        {
            return Err(StoreError::VerifyFailed);
        }
        let kept = self.keep("vault-v1", &original)?;
        self.save_bytes(file.to_json().as_bytes())?;
        match self.load() {
            Loaded::V2(stored) if *stored == *file => Ok(kept
                .file_name()
                .map(|n| n.to_string_lossy().into_owned())
                .unwrap_or_default()),
            _ => {
                write_atomically(&self.dir, &self.file(), &original)?;
                Err(StoreError::VerifyFailed)
            }
        }
    }

    /// Keeps `bytes` as `<stem>.json`, or the first free `<stem>-N.json`,
    /// never replacing a file: a temp file is written and flushed, then
    /// linked to the name (which fails if the name exists), and read back.
    /// An existing copy with the very same bytes is used as it is.
    fn keep(&self, stem: &str, bytes: &[u8]) -> Result<PathBuf, StoreError> {
        for n in 1..1000 {
            let target = self.dir.join(numbered(stem, n));
            if target.exists() {
                if fs::read(&target)? == bytes {
                    return Ok(target);
                }
                continue;
            }
            write_new(&self.dir, &target, bytes)?;
            if fs::read(&target)? != bytes {
                return Err(StoreError::VerifyFailed);
            }
            return Ok(target);
        }
        Err(StoreError::Io)
    }

    /// The v1 file the latest conversion kept (the newest `vault-v1*.json`
    /// by modification time), if there is one.
    pub fn kept_v1(&self) -> Option<PathBuf> {
        let entries = fs::read_dir(&self.dir).ok()?;
        entries
            .filter_map(Result::ok)
            .filter(|entry| {
                let name = entry.file_name().to_string_lossy().into_owned();
                name == "vault-v1.json"
                    || name
                        .strip_prefix("vault-v1-")
                        .and_then(|rest| rest.strip_suffix(".json"))
                        .is_some_and(|n| !n.is_empty() && n.bytes().all(|b| b.is_ascii_digit()))
            })
            .filter_map(|entry| Some((entry.metadata().ok()?.modified().ok()?, entry.path())))
            .max_by_key(|(modified, _)| *modified)
            .map(|(_, path)| path)
    }

    /// What `restore` would put back when the vault file can't be opened
    /// (or is a v2 file an unlock found damaged; see `mark_damaged_body`):
    /// the backup if it is a readable v2 vault other than that file (it holds
    /// the latest changes it can), else the v1 file a conversion kept, if it
    /// reads.
    pub fn restore_source(&self) -> Option<Restore> {
        let current = fs::read(self.file()).ok();
        match self.load() {
            Loaded::Values(_) => return None,
            Loaded::V2(_) => {
                let hash = current.as_deref().map(sodium::sha256);
                if hash.is_none() || hash != self.damaged_body {
                    return None;
                }
            }
            Loaded::Nothing | Loaded::Unreadable => {}
        }
        if let Ok(bytes) = fs::read(self.backup()) {
            if matches!(read_vault(&bytes), Loaded::V2(_)) && Some(&bytes) != current.as_ref() {
                return Some(Restore::Backup);
            }
        }
        let kept = self.kept_v1()?;
        let bytes = fs::read(&kept).ok()?;
        matches!(read_vault(&bytes), Loaded::Values(_)).then_some(Restore::KeptV1(kept))
    }

    /// Puts back what `restore_source` names, over a vault file that can't
    /// be opened (or is missing). That file is kept too
    /// (`vault-unreadable.json`, ...): nothing is ever deleted.
    pub fn restore(&self) -> Result<Restore, StoreError> {
        let source = self.restore_source().ok_or(StoreError::Unreadable)?;
        let bytes = match &source {
            Restore::Backup => fs::read(self.backup())?,
            Restore::KeptV1(path) => fs::read(path)?,
        };
        if self.file().exists() {
            let damaged = fs::read(self.file())?;
            self.keep("vault-unreadable", &damaged)?;
        }
        create_private_dir(&self.dir)?;
        write_atomically(&self.dir, &self.file(), &bytes)?;
        match self.load() {
            Loaded::Values(_) | Loaded::V2(_) => Ok(source),
            _ => Err(StoreError::VerifyFailed),
        }
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
        self.save_bytes(&bytes)
    }

    fn save_bytes(&self, bytes: &[u8]) -> Result<(), StoreError> {
        create_private_dir(&self.dir)?;
        if self.file().exists() {
            // Refresh the backup by copying, so vault.json never goes missing.
            let previous = fs::read(self.file())?;
            // A v2 backup about to be replaced by a file that isn't v2 (an
            // old v1 copy put back) may be the newest copy there is: keep it
            // first, under its own name. (A v1 backup replaced after an
            // upgrade is already kept as vault-v1.json.)
            if let Ok(backup) = fs::read(self.backup()) {
                let is_v2 = |bytes: &[u8]| matches!(read_vault(bytes), Loaded::V2(_));
                if is_v2(&backup) && !is_v2(&previous) {
                    self.keep("vault-bak", &backup)?;
                }
            }
            write_atomically(&self.dir, &self.backup(), &previous)?;
        }
        write_atomically(&self.dir, &self.file(), bytes)
    }
}

/// A vault file's bytes: format v1 (the localStorage values) or v2, by its
/// `formatVersion`. Anything else, or anything either format refuses, is
/// unreadable, and so never written over.
fn read_vault(bytes: &[u8]) -> Loaded {
    let Ok(text) = std::str::from_utf8(bytes) else {
        return Loaded::Unreadable;
    };
    let Ok(header) = serde_json::from_str::<serde_json::Value>(text) else {
        return Loaded::Unreadable;
    };
    if header["format"] != FORMAT {
        return Loaded::Unreadable;
    }
    match header["formatVersion"].as_u64() {
        Some(2) => match v2::File::parse(text) {
            Ok(file) => Loaded::V2(Box::new(file)),
            Err(_) => Loaded::Unreadable,
        },
        Some(FORMAT_VERSION_1) => match serde_json::from_str::<VaultFile>(text) {
            Ok(file) if file.format_version == FORMAT_VERSION => Loaded::Values(file.data),
            _ => Loaded::Unreadable,
        },
        _ => Loaded::Unreadable,
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

/// `<stem>.json`, then `<stem>-2.json`, `<stem>-3.json`, ...
fn numbered(stem: &str, n: usize) -> String {
    if n == 1 {
        format!("{stem}.json")
    } else {
        format!("{stem}-{n}.json")
    }
}

/// Writes `bytes` to a new file at `target`, which must not exist: a temp
/// file is written and flushed, then hard-linked to `target` (failing if it
/// exists, so nothing is ever replaced), and the folder flushed. The temp
/// file is removed either way.
fn write_new(dir: &Path, target: &Path, bytes: &[u8]) -> Result<(), StoreError> {
    let mut suffix = [0u8; 8];
    sodium::random_bytes(&mut suffix);
    let temp = dir.join(format!(
        ".keep.{}.tmp",
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
        fs::hard_link(&temp, target)?;
        sync_dir(dir)
    })();
    let _ = fs::remove_file(&temp);
    result.map_err(StoreError::from)
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

    /// A v2 file sealed with fixed keys (no Argon2id here).
    fn a_v2_file() -> v2::File {
        let app = still_core::crypto::Key::random();
        let body = v2::Body {
            lenses: "[]".into(),
            bin: "[]".into(),
        };
        v2::seal_file(
            &app,
            &still_core::crypto::Key::random(),
            v2::Kdf::new_sensitive(),
            &body,
            None,
        )
    }

    #[test]
    fn writes_and_reads_a_v2_vault_keeping_the_backup() {
        let tmp = TempDir::new();
        let store = tmp.store();
        let first = a_v2_file();
        store.write_v2(&first).unwrap();
        assert_eq!(store.load(), Loaded::V2(Box::new(first.clone())));
        let second = a_v2_file();
        store.write_v2(&second).unwrap();
        assert_eq!(store.load(), Loaded::V2(Box::new(second)));
        assert_eq!(fs::read_to_string(store.backup()).unwrap(), first.to_json());
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            let mode = fs::metadata(store.file()).unwrap().permissions().mode();
            assert_eq!(mode & 0o777, 0o600);
        }
    }

    #[test]
    fn never_mixes_the_two_formats() {
        let tmp = TempDir::new();
        let store = tmp.store();
        store.write_v2(&a_v2_file()).unwrap();
        let before = fs::read(store.file()).unwrap();
        // v1 values never go into a v2 vault.
        assert_eq!(
            store.write(&set(&[("still-lenses", Some("[]"))])),
            Err(StoreError::OtherFormat)
        );
        assert_eq!(fs::read(store.file()).unwrap(), before);

        // A normal v2 save never goes over a v1 vault (only the conversion does).
        let v1 = TempDir::new();
        let v1_store = v1.store();
        v1_store.import_legacy(real_vault()).unwrap();
        let before = fs::read(v1_store.file()).unwrap();
        assert_eq!(
            v1_store.write_v2(&a_v2_file()),
            Err(StoreError::OtherFormat)
        );
        assert_eq!(fs::read(v1_store.file()).unwrap(), before);
    }

    #[test]
    fn treats_a_damaged_v2_file_as_unreadable_and_never_writes_over_it() {
        let tmp = TempDir::new();
        let store = tmp.store();
        let file = a_v2_file();
        store.write_v2(&file).unwrap();
        let damaged = file
            .to_json()
            .replace("\"formatVersion\": 2", "\"formatVersion\": 2 ");
        fs::write(store.file(), &damaged).unwrap();
        assert_eq!(store.load(), Loaded::Unreadable);
        assert_eq!(store.write_v2(&a_v2_file()), Err(StoreError::Unreadable));
        assert_eq!(fs::read_to_string(store.file()).unwrap(), damaged);
        // An unknown format version is unreadable too.
        fs::write(
            store.file(),
            r#"{"format":"still-vault","formatVersion":3}"#,
        )
        .unwrap();
        assert_eq!(store.load(), Loaded::Unreadable);
    }

    /// A store holding the real exported vault (v1), and its file's bytes.
    fn real_v1(tmp: &TempDir) -> (Store, Vec<u8>) {
        let store = tmp.store();
        store.import_legacy(real_vault()).unwrap();
        let bytes = fs::read(store.file()).unwrap();
        (store, bytes)
    }

    /// Every vault value as the backend reads it before the password step.
    fn expected(values: &Values) -> Vec<(String, Option<String>)> {
        [
            "still-encrypted-master-key",
            "still-salt",
            "still-has-pin",
            "still-lenses",
            "still-recycle-bin",
        ]
        .iter()
        .map(|key| ((*key).to_owned(), values.get(*key).cloned()))
        .collect()
    }

    #[test]
    fn converts_to_v2_keeping_the_v1_file_byte_for_byte() {
        let tmp = TempDir::new();
        let (store, v1_bytes) = real_v1(&tmp);
        let file = a_v2_file();
        let kept = store
            .convert_to_v2(&file, &expected(&real_vault()))
            .unwrap();
        assert_eq!(kept, "vault-v1.json");
        assert_eq!(fs::read(store.dir.join(&kept)).unwrap(), v1_bytes);
        assert_eq!(store.load(), Loaded::V2(Box::new(file)));
        // No temp files are left behind.
        let names: Vec<String> = fs::read_dir(&store.dir)
            .unwrap()
            .map(|e| e.unwrap().file_name().into_string().unwrap())
            .collect();
        assert!(names.iter().all(|n| !n.ends_with(".tmp")), "{names:?}");
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            let mode = fs::metadata(store.dir.join(&kept))
                .unwrap()
                .permissions()
                .mode();
            assert_eq!(mode & 0o777, 0o600);
        }
    }

    #[test]
    fn never_writes_over_a_kept_v1_file() {
        let tmp = TempDir::new();
        let (store, v1_bytes) = real_v1(&tmp);
        // A different file already holds the name; an identical one is reused.
        fs::write(store.dir.join("vault-v1.json"), b"someone else's").unwrap();
        fs::write(store.dir.join("vault-v1-2.json"), &v1_bytes).unwrap();
        let kept = store
            .convert_to_v2(&a_v2_file(), &expected(&real_vault()))
            .unwrap();
        assert_eq!(kept, "vault-v1-2.json");
        assert_eq!(
            fs::read(store.dir.join("vault-v1.json")).unwrap(),
            b"someone else's"
        );

        let tmp = TempDir::new();
        let (store, v1_bytes) = real_v1(&tmp);
        fs::write(store.dir.join("vault-v1.json"), b"not this vault").unwrap();
        let kept = store
            .convert_to_v2(&a_v2_file(), &expected(&real_vault()))
            .unwrap();
        assert_eq!(kept, "vault-v1-2.json");
        assert_eq!(fs::read(store.dir.join(kept)).unwrap(), v1_bytes);
    }

    #[test]
    fn refuses_to_convert_anything_but_the_vault_it_read() {
        // Any value changed since it was read (a list, or the key: another
        // vault with the same lists) is refused, and nothing is touched.
        for key in ["still-recycle-bin", "still-encrypted-master-key"] {
            let tmp = TempDir::new();
            let (store, v1_bytes) = real_v1(&tmp);
            let mut changed = real_vault();
            changed.insert(key.into(), "something else".into());
            assert_eq!(
                store.convert_to_v2(&a_v2_file(), &expected(&changed)),
                Err(StoreError::VerifyFailed),
                "{key}"
            );
            assert_eq!(fs::read(store.file()).unwrap(), v1_bytes);
            assert!(!store.dir.join("vault-v1.json").exists());
        }

        // A v2 vault is never converted again.
        let tmp = TempDir::new();
        let store = tmp.store();
        store.write_v2(&a_v2_file()).unwrap();
        assert_eq!(
            store.convert_to_v2(&a_v2_file(), &[]),
            Err(StoreError::OtherFormat)
        );
    }

    // After an upgrade the backup is a good v2 copy. An old v1 file put back
    // (and then saved, or restored over) must never replace it unkept.
    #[test]
    fn keeps_a_backup_that_a_file_in_the_other_format_would_replace() {
        let tmp = TempDir::new();
        let store = tmp.store();
        let first = a_v2_file();
        store.write_v2(&first).unwrap();
        store.write_v2(&a_v2_file()).unwrap();
        let backup = fs::read(store.backup()).unwrap();
        assert_eq!(backup, first.to_json().into_bytes());

        // An old v1 file is put in place, and a save replaces the backup.
        let v1 = TempDir::new();
        let (_, v1_bytes) = real_v1(&v1);
        fs::write(store.file(), &v1_bytes).unwrap();
        store.write(&set(&[("still-lenses", Some("[]"))])).unwrap();
        assert_eq!(fs::read(store.dir.join("vault-bak.json")).unwrap(), backup);
        assert_eq!(fs::read(store.backup()).unwrap(), v1_bytes);
    }

    // The normal path after an upgrade: the v1 backup is replaced by v2
    // files, and no extra copy is made (vault-v1.json already has it).
    #[test]
    fn makes_no_extra_copy_when_saves_follow_an_upgrade() {
        let tmp = TempDir::new();
        let (store, _) = real_v1(&tmp);
        store
            .write(&set(&[("still-has-pin", Some("false"))]))
            .unwrap();
        store
            .convert_to_v2(&a_v2_file(), &expected(&real_vault()))
            .unwrap();
        store.write_v2(&a_v2_file()).unwrap();
        store.write_v2(&a_v2_file()).unwrap();
        assert!(!store.dir.join("vault-bak.json").exists());
    }

    #[test]
    fn restores_the_newest_kept_copy_keeping_the_unreadable_file() {
        // The backup is a readable v2 vault: it is newer than the v1 file.
        let tmp = TempDir::new();
        let store = tmp.store();
        let good = a_v2_file();
        store.write_v2(&good).unwrap();
        store.write_v2(&a_v2_file()).unwrap();
        fs::write(store.dir.join("vault-v1.json"), b"older").unwrap();
        fs::write(store.file(), b"{damaged").unwrap();
        assert_eq!(store.restore_source(), Some(Restore::Backup));
        assert_eq!(store.restore(), Ok(Restore::Backup));
        assert_eq!(store.load(), Loaded::V2(Box::new(good)));
        assert_eq!(
            fs::read(store.dir.join("vault-unreadable.json")).unwrap(),
            b"{damaged"
        );

        // No backup, no vault.json: the v1 file is offered and put back.
        let tmp = TempDir::new();
        let (v1_store, v1_bytes) = real_v1(&tmp);
        fs::rename(v1_store.file(), v1_store.dir.join("vault-v1.json")).unwrap();
        assert_eq!(v1_store.load(), Loaded::Nothing);
        let kept = v1_store.dir.join("vault-v1.json");
        assert_eq!(
            v1_store.restore_source(),
            Some(Restore::KeptV1(kept.clone()))
        );
        assert_eq!(v1_store.restore(), Ok(Restore::KeptV1(kept)));
        assert_eq!(fs::read(v1_store.file()).unwrap(), v1_bytes);

        // Never over a vault that opens.
        assert_eq!(v1_store.restore_source(), None);
        assert_eq!(v1_store.restore(), Err(StoreError::Unreadable));
    }

    #[test]
    fn picks_the_newest_kept_v1_file() {
        let tmp = TempDir::new();
        let store = tmp.store();
        create_private_dir(&store.dir).unwrap();
        for (name, age) in [
            ("vault-v1.json", 10),
            ("vault-v1-3.json", 5),
            ("vault-v1-2.json", 20),
        ] {
            let path = store.dir.join(name);
            fs::write(&path, name).unwrap();
            let time = std::time::SystemTime::now() - std::time::Duration::from_secs(age * 60);
            File::options()
                .write(true)
                .open(&path)
                .unwrap()
                .set_modified(time)
                .unwrap();
        }
        fs::write(store.dir.join("vault-v1-x.json"), b"not a kept copy").unwrap();
        assert_eq!(store.kept_v1(), Some(store.dir.join("vault-v1-3.json")));
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
