//! The vault backend: the only code that touches stored vault data, and the
//! only user of the vault's keys. Callers see ids and metadata (`view`), and
//! a secret's value only when they reveal it.
//!
//! The rules, as in the TypeScript backend this replaces (and its recorded
//! behaviour, fixtures/vault-behaviour-v1):
//! - Every change is written to storage, in one all-or-nothing write, before
//!   it becomes visible. A Lens moving between lists is saved in both at once.
//! - A failed write changes nothing.
//! - Lenses are kept exactly as stored. Unlocking writes nothing (except the
//!   Archive purge), and a Lens whose key doesn't open is kept but hidden.
//! - A stored list that can't be read blocks unlocking, since any save
//!   would overwrite it.
//! - Vault data without its key or salt is orphaned: `create` refuses, and
//!   `set_aside` moves it out of the way first.
//! - Lock clears everything at once, and nothing changes while locked.
//!
//! Callers run one operation at a time (`&mut self`), so a Lock waits for a
//! change already under way. Creating and unlocking run Argon2id, which takes
//! seconds; they are split into prepare, the slow part (which needs no
//! backend), and finish, so the caller can run the slow part without holding
//! a lock. A Lock in between wins: the finished unlock is thrown away.

use std::collections::HashSet;
use std::sync::Arc;

use serde_json::{json, Map, Value};

use super::format::is_v1_master_key;
use super::json::{parse_list, write_list};
use super::model::{self, id_of, js_trim, Change, Lists};
use super::time;
use crate::crypto::is_js_whitespace;
use crate::session::{SecretText, SessionError, Unlocked, WrappedLensKey};
use crate::sodium;
use crate::v2;

/// The stored values, under the names older versions used in localStorage.
pub mod keys {
    pub const MASTER_KEY: &str = "still-encrypted-master-key";
    pub const SALT: &str = "still-salt";
    pub const HAS_PIN: &str = "still-has-pin";
    pub const LENSES: &str = "still-lenses";
    pub const BIN: &str = "still-recycle-bin";
    /// Every vault value, in the order set-aside copies them.
    pub const ALL: [&str; 5] = [MASTER_KEY, SALT, HAS_PIN, LENSES, BIN];
}

/// A write the storage refused. Nothing of it was saved.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct StorageError;

/// Where the vault's values live. Each write sets (`Some`) or removes
/// (`None`) several values, in order, and either all of it is saved or none.
pub trait Storage {
    fn get(&self, key: &str) -> Option<String>;
    /// Every stored key, for set-aside to find a free name.
    fn keys(&self) -> Vec<String>;
    fn write(&mut self, changes: &[(String, Option<String>)]) -> Result<(), StorageError>;

    /// The stored vault, when it is in format v2. While it is, the v1 values
    /// above are empty and writing them fails.
    fn v2(&self) -> Option<v2::File> {
        None
    }
    /// Replaces the stored v2 vault in one all-or-nothing write.
    fn write_v2(&mut self, _file: &v2::File) -> Result<(), StorageError> {
        Err(StorageError)
    }
    /// Whether a new vault is created in format v2 here.
    fn creates_v2(&self) -> bool {
        false
    }
    /// Whether a v1 vault is converted to v2 here on its first unlock.
    fn converts_v1(&self) -> bool {
        false
    }
    /// The stored vault file exists but can't be read. Nothing is offered
    /// that would write over it, such as creating a new vault.
    fn unreadable(&self) -> bool {
        false
    }
    /// An unlock found that the stored v2 vault's body doesn't open, though
    /// the password did: the file passed its header checks but is damaged.
    /// The storage may offer to put back a kept copy over exactly that file.
    fn mark_damaged(&mut self) {}
    /// Replaces the stored v1 vault with this v2 file, keeping the v1 file
    /// (docs/vault-format-v2.md, "Converting from v1"). Refuses unless every
    /// value in `expected` is still exactly as it was read before the
    /// password step (a missing one still missing). On any failure the v1
    /// vault is left as it was. Returns the kept copy's name.
    /// Replaces the stored v2 vault with this one, the same vault under a new
    /// password, in one all-or-nothing write that is read back, and makes
    /// the backup a copy of it too, so the everyday backup doesn't keep the
    /// old password. Returns the names of other kept copies, which may still
    /// open with the old password (they are never deleted).
    fn write_rekeyed_v2(&mut self, _file: &v2::File) -> Result<Vec<String>, StorageError> {
        Err(StorageError)
    }
    fn convert_to_v2(
        &mut self,
        _file: &v2::File,
        _expected: &[(String, Option<String>)],
    ) -> Result<String, StorageError> {
        Err(StorageError)
    }
}

/// The keys of an unlocked vault. [`Unlocked`] is the real one; tests may
/// use a faster stand-in for the password step.
pub trait Keys: Sized {
    /// A new vault: returns the keys, the wrapped app key and the salt.
    fn create(password: &SecretText) -> Result<(Self, String, String), SessionError>;
    /// Opens the app key, then each Lens key; one entry per Lens, true if it opened.
    fn open(
        encrypted_master_key: &str,
        salt: &str,
        password: &SecretText,
        lenses: &[WrappedLensKey<'_>],
    ) -> Result<(Self, Vec<bool>), SessionError>;
    fn new_lens_key(&mut self, lens_id: &str) -> String;
    fn encrypt_item(&self, lens_id: &str, plaintext: &SecretText) -> Result<String, SessionError>;
    fn decrypt_item(&self, lens_id: &str, blob: &str) -> Result<SecretText, SessionError>;

    /// A new vault in format v2, with an empty body; it opens before it's returned.
    fn create_v2(password: &SecretText) -> Result<(Self, v2::File), SessionError>;
    /// Opens a v2 file's app key and body; Lens keys come after, from the body.
    fn open_v2(file: &v2::File, password: &SecretText) -> Result<(Self, v2::Body), SessionError>;
    fn open_lens_keys(&mut self, lenses: &[WrappedLensKey<'_>]) -> Vec<bool>;
    /// The file with this body sealed in; its settings and wrapped key unchanged.
    fn seal_v2(&self, file: &v2::File, body: &v2::Body) -> v2::File;
    /// This vault, opened from v1, as a new v2 file holding these lists,
    /// checked to open to the same key and lists before it's returned.
    fn convert_v2(&self, password: &SecretText, body: &v2::Body) -> Result<v2::File, SessionError>;
    /// The same vault under a new password and settings, opened with the
    /// current one and checked before it's returned (see Unlocked).
    fn change_password_v2(
        file: &v2::File,
        current: &SecretText,
        new: &SecretText,
        kdf: v2::Kdf,
        body: &v2::Body,
    ) -> Result<(Self, v2::File), SessionError>;
    /// Whether both hold the same app key: the same vault.
    fn same_app_key(&self, other: &Self) -> bool;
}

impl Keys for Unlocked {
    fn create(password: &SecretText) -> Result<(Self, String, String), SessionError> {
        Unlocked::create(password)
    }

    fn open(
        encrypted_master_key: &str,
        salt: &str,
        password: &SecretText,
        lenses: &[WrappedLensKey<'_>],
    ) -> Result<(Self, Vec<bool>), SessionError> {
        Unlocked::open(encrypted_master_key, salt, password, lenses)
    }

    fn new_lens_key(&mut self, lens_id: &str) -> String {
        Unlocked::new_lens_key(self, lens_id)
    }

    fn encrypt_item(&self, lens_id: &str, plaintext: &SecretText) -> Result<String, SessionError> {
        Unlocked::encrypt_item(self, lens_id, plaintext)
    }

    fn decrypt_item(&self, lens_id: &str, blob: &str) -> Result<SecretText, SessionError> {
        Unlocked::decrypt_item(self, lens_id, blob)
    }

    fn create_v2(password: &SecretText) -> Result<(Self, v2::File), SessionError> {
        Unlocked::create_v2(password)
    }

    fn open_v2(file: &v2::File, password: &SecretText) -> Result<(Self, v2::Body), SessionError> {
        Unlocked::open_v2(file, password)
    }

    fn open_lens_keys(&mut self, lenses: &[WrappedLensKey<'_>]) -> Vec<bool> {
        Unlocked::open_lens_keys(self, lenses)
    }

    fn seal_v2(&self, file: &v2::File, body: &v2::Body) -> v2::File {
        Unlocked::seal_v2(self, file, body)
    }

    fn convert_v2(&self, password: &SecretText, body: &v2::Body) -> Result<v2::File, SessionError> {
        Unlocked::convert_v2(self, password, body)
    }
    fn change_password_v2(
        file: &v2::File,
        current: &SecretText,
        new: &SecretText,
        kdf: v2::Kdf,
        body: &v2::Body,
    ) -> Result<(Self, v2::File), SessionError> {
        Unlocked::change_password_v2(file, current, new, kdf, body)
    }
    fn same_app_key(&self, other: &Self) -> bool {
        Unlocked::same_app_key(self, other)
    }
}

/// Why a change, reveal or create was refused. `code()` is what the UI sees.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum VaultError {
    /// The vault is locked.
    Locked,
    /// create: a vault, or orphaned vault data, is already stored.
    VaultExists,
    UnknownLens,
    UnknownItem,
    /// A secret's label is blank.
    EmptyLabel,
    /// A Lens's name is blank.
    EmptyName,
    /// A secret's value is blank (JavaScript's definition of whitespace).
    EmptyValue,
    /// A change could not be saved; nothing changed.
    WriteFailed,
    /// The vault is in the old format (opened as it is): it must be upgraded
    /// before its password can be changed.
    NeedsUpgrade,
    /// create or set-aside could not be saved; nothing changed.
    StorageFailed,
    /// The keys refused: a Lens whose key didn't open, a damaged value, or
    /// a failed password step.
    Crypto(SessionError),
}

impl VaultError {
    pub fn code(self) -> &'static str {
        match self {
            Self::Locked => "locked",
            Self::VaultExists => "vault-exists",
            Self::UnknownLens => "unknown-lens",
            Self::UnknownItem => "unknown-item",
            Self::EmptyLabel => "empty-label",
            Self::EmptyName => "empty-name",
            Self::EmptyValue => "empty-value",
            Self::WriteFailed => "write-failed",
            Self::NeedsUpgrade => "needs-upgrade",
            Self::StorageFailed => "storage-failed",
            Self::Crypto(SessionError::WrongPassword) => "crypto-wrong-password",
            Self::Crypto(SessionError::Corrupt) => "crypto-corrupt",
            Self::Crypto(SessionError::Failed) => "crypto-failed",
            Self::Crypto(SessionError::Locked) => "crypto-locked",
            Self::Crypto(SessionError::UnknownLens) => "crypto-unknown-lens",
        }
    }
}

impl std::fmt::Display for VaultError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(self.code())
    }
}

impl std::error::Error for VaultError {}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Status {
    Empty,
    Locked,
    Unlocked,
    /// Vault data is stored, but its master key or salt is missing.
    Orphaned,
    /// The vault file can't be read; nothing is done that could write over it.
    Unreadable,
}

impl Status {
    pub fn code(self) -> &'static str {
        match self {
            Self::Empty => "empty",
            Self::Locked => "locked",
            Self::Unlocked => "unlocked",
            Self::Orphaned => "orphaned",
            Self::Unreadable => "unreadable",
        }
    }
}

/// Why unlocking didn't happen.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum UnlockFailure {
    NoVault,
    WrongPassword,
    /// Stored vault data is damaged; nothing was opened or changed.
    UnreadableData,
    /// Anything else, such as not enough memory for Argon2id, or a Lock
    /// that happened while the password was being checked.
    Failed,
}

impl UnlockFailure {
    pub fn code(self) -> &'static str {
        match self {
            Self::NoVault => "no-vault",
            Self::WrongPassword => "wrong-password",
            Self::UnreadableData => "unreadable-data",
            Self::Failed => "failed",
        }
    }
}

/// What the UI sees: ids and metadata, no keys and no encrypted values.
#[derive(Debug, Clone, PartialEq)]
pub struct View {
    /// Each readable Lens as {id, name, createdAt, itemCount, items: [{id,
    /// label, type}], deletedAt?}, with values exactly as stored.
    pub lenses: Vec<Value>,
    /// The same, plus purgeAt: when the Archive purge will delete it (ISO),
    /// or null if its deletedAt can't be read, so it's kept until deleted.
    pub bin: Vec<Value>,
    /// Lenses whose key could not be unwrapped. They are kept, unchanged, but not shown.
    pub unreadable: usize,
}

impl View {
    pub fn to_json(&self) -> Value {
        json!({ "lenses": self.lenses, "bin": self.bin, "unreadable": self.unreadable })
    }
}

/// What `prepare_unlock` read, for the slow password step and `finish_unlock`.
pub struct UnlockPlan {
    generation: u64,
    source: Source,
}

enum Source {
    /// v1: the lists are readable before the password.
    V1 {
        stored: Lists,
        encrypted_master_key: String,
        salt: String,
        /// The lists exactly as stored, for converting to v2 (a missing list is "[]").
        raw: v2::Body,
        /// Every vault value as it was read, for the conversion to check
        /// nothing changed meanwhile.
        expected: Vec<(String, Option<String>)>,
        /// Convert to v2 during this unlock.
        convert: bool,
    },
    /// v2: the lists are inside the body, opened with the password.
    V2 { file: v2::File },
}

/// What the password step opened, for `finish_unlock`.
pub struct Opened<K> {
    keys: K,
    /// One entry per stored Lens (Lenses, then Archive): true if its key opened.
    opened: Vec<bool>,
    stored: Lists,
    /// v2: the lists exactly as stored in the body. None for v1.
    raw: Option<v2::Body>,
    /// A v1 vault's conversion: not tried (None), or the checked v2 file
    /// with the lists it holds, or a failure.
    converted: Option<Result<(v2::File, v2::Body), SessionError>>,
}

/// One entry per stored Lens (Lenses, then Archive): its id and wrapped key,
/// when both are strings. Fails on a null entry (the TypeScript backend did:
/// it read fields of every entry before opening any).
fn wrapped_keys(stored: &Lists) -> Result<Vec<Option<(String, String)>>, UnlockFailure> {
    let all = stored.lenses.iter().chain(&stored.bin);
    if all.clone().any(Value::is_null) {
        return Err(UnlockFailure::Failed);
    }
    Ok(all
        .map(|lens| {
            let key = lens.get("encryptedMasterKey")?.as_str()?;
            Some((id_of(lens)?.to_owned(), key.to_owned()))
        })
        .collect())
}

/// Opens the Lens keys that can be opened; one entry per stored Lens.
fn open_lenses<K: Keys>(keys: &mut K, wrapped: &[Option<(String, String)>]) -> Vec<bool> {
    let lenses: Vec<WrappedLensKey<'_>> = wrapped
        .iter()
        .flatten()
        .map(|(id, key)| WrappedLensKey {
            id,
            encrypted_master_key: key,
        })
        .collect();
    // Spread the results back over every entry; those not passed didn't open.
    let mut results = keys.open_lens_keys(&lenses).into_iter();
    wrapped
        .iter()
        .map(|entry| entry.is_some() && results.next().unwrap_or(false))
        .collect()
}

impl UnlockPlan {
    /// The slow part: Argon2id, then (in v2) the body, then every Lens key.
    /// Needs no backend.
    pub fn open<K: Keys>(&self, password: &SecretText) -> Result<Opened<K>, SessionError> {
        match &self.source {
            Source::V1 {
                stored,
                encrypted_master_key,
                salt,
                raw,
                convert,
                ..
            } => {
                let wrapped = wrapped_keys(stored).map_err(|_| SessionError::Failed)?;
                let lenses: Vec<WrappedLensKey<'_>> = wrapped
                    .iter()
                    .flatten()
                    .map(|(id, key)| WrappedLensKey {
                        id,
                        encrypted_master_key: key,
                    })
                    .collect();
                let (keys, opened) = K::open(encrypted_master_key, salt, password, &lenses)?;
                let mut results = opened.into_iter();
                let opened = wrapped
                    .iter()
                    .map(|entry| entry.is_some() && results.next().unwrap_or(false))
                    .collect();
                // Converting runs Argon2id twice more (a new salt, then an
                // independent check); it happens here, outside any lock.
                let converted = convert.then(|| {
                    let body = v2::Body {
                        lenses: raw.lenses.clone(),
                        bin: raw.bin.clone(),
                    };
                    keys.convert_v2(password, &body).map(|file| (file, body))
                });
                Ok(Opened {
                    keys,
                    opened,
                    stored: stored.clone(),
                    raw: None,
                    converted,
                })
            }
            Source::V2 { file } => {
                let (mut keys, body) = K::open_v2(file, password)?;
                // The body is authenticated: lists it can't read are damaged data.
                let lenses = parse_list(Some(&body.lenses)).map_err(|_| SessionError::Corrupt)?;
                let bin = parse_list(Some(&body.bin)).map_err(|_| SessionError::Corrupt)?;
                let stored = Lists { lenses, bin };
                let wrapped = wrapped_keys(&stored).map_err(|_| SessionError::Failed)?;
                let opened = open_lenses(&mut keys, &wrapped);
                Ok(Opened {
                    keys,
                    opened,
                    stored,
                    raw: Some(body),
                    converted: None,
                })
            }
        }
    }
}

/// How hard the master password is to guess: Argon2id's settings.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Strength {
    /// libsodium's SENSITIVE settings (1 GiB, 4 passes), as every vault so far.
    Standard,
    /// The same memory with twice the passes: unlocking, and every guess,
    /// takes about twice as long, with no more memory than Standard.
    Stronger,
}

impl Strength {
    fn kdf(self) -> v2::Kdf {
        match self {
            Self::Standard => v2::Kdf::new_sensitive(),
            // Twice OPS_MIN is well inside OPS_MAX, so no check is needed.
            Self::Stronger => v2::Kdf {
                ops_limit: v2::OPS_MIN * 2,
                ..v2::Kdf::new_sensitive()
            },
        }
    }
}

/// What `prepare_change_password` read, for the password step and
/// `finish_change_password`.
pub struct ChangePlan {
    generation: u64,
    file: v2::File,
    body: v2::Body,
}

impl ChangePlan {
    /// The slow part: Argon2id three times (the current password, the new
    /// one, and the check). Needs no backend.
    pub fn change<K: Keys>(
        &self,
        current: &SecretText,
        new: &SecretText,
        strength: Strength,
    ) -> Result<(K, v2::File), SessionError> {
        K::change_password_v2(&self.file, current, new, strength.kdf(), &self.body)
    }
}

/// What `prepare_create` checked, for the password step and `finish_create`.
pub struct CreatePlan {
    generation: u64,
    v2: bool,
}

/// A new vault from the password step.
pub enum Created<K> {
    /// The keys, the wrapped app key and the salt.
    V1(K, String, String),
    V2(K, v2::File),
}

impl CreatePlan {
    /// The slow part: Argon2id (twice, to check the new vault opens). Needs
    /// no backend.
    pub fn create<K: Keys>(&self, password: &SecretText) -> Result<Created<K>, SessionError> {
        if self.v2 {
            let (keys, file) = K::create_v2(password)?;
            Ok(Created::V2(keys, file))
        } else {
            let (keys, blob, salt) = K::create(password)?;
            Ok(Created::V1(keys, blob, salt))
        }
    }
}

/// The current time, in milliseconds since 1970.
pub type Clock = Arc<dyn Fn() -> i64 + Send + Sync>;

pub fn system_clock() -> Clock {
    Arc::new(|| {
        let since = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap_or_default();
        i64::try_from(since.as_millis()).unwrap_or(i64::MAX)
    })
}

/// The unlocked vault: its keys, its lists and how it is saved. All of it
/// exists only while unlocked, so locking drops it in one step and no part
/// can outlive the rest (the keys and the v2 body zero themselves).
struct Session<K> {
    keys: K,
    lists: Lists,
    /// Lens ids whose key opened. Others are kept but not shown.
    readable: HashSet<String>,
    format: Format,
    /// The secret deleted last, so it can be put back (`restore_item`).
    /// Memory only, never written; it goes with the session at lock.
    deleted: Option<Deleted>,
}

/// A deleted secret as it was stored: its value stays encrypted.
struct Deleted {
    lens_id: String,
    item: Value,
    /// Its position in the Lens when it was deleted.
    index: usize,
    at_ms: i64,
}

/// How long a deleted secret can be put back.
pub const RESTORE_MS: i64 = 30_000;

/// How the unlocked vault is saved, with what each format's saves check.
enum Format {
    /// The wrapped app key and salt the vault was unlocked or created with.
    /// Saves refuse unless the stored ones are still these: writing the
    /// lists into another vault's values (or a file that's gone) would leave
    /// them under a key that can't open them.
    V1 { master_key: String, salt: String },
    /// The file as this vault last opened or saved it, and both lists exactly
    /// as stored. Saves seal onto the file's settings and wrapped key, and
    /// refuse if the file on disk has another vault's (sealing onto that
    /// would make the vault unopenable); a list a change leaves alone is
    /// written back byte for byte, as in v1.
    V2 { file: v2::File, raw: v2::Body },
}

impl<K: Keys> Session<K> {
    fn new(keys: K, format: Format) -> Self {
        Self {
            keys,
            lists: Lists::default(),
            readable: HashSet::new(),
            format,
            deleted: None,
        }
    }

    /// Refuses a change to a stored Lens whose key didn't open, as if it
    /// didn't exist: it's kept exactly as stored. Checked before every change.
    fn refuse_hidden(&self, lens_id: &str) -> Result<(), VaultError> {
        let stored = self
            .lists
            .lenses
            .iter()
            .chain(&self.lists.bin)
            .any(|l| id_of(l) == Some(lens_id));
        if stored && !self.readable.contains(lens_id) {
            return Err(VaultError::UnknownLens);
        }
        Ok(())
    }

    fn active_lens(&self, lens_id: &str) -> Option<&Value> {
        self.lists.lenses.iter().find(|l| id_of(l) == Some(lens_id))
    }

    /// Encrypts a value for a Lens: its key must have opened, and the value
    /// must not be blank.
    fn encrypt(&self, lens_id: &str, value: &SecretText) -> Result<String, VaultError> {
        self.keys.encrypt_item(lens_id, value).map_err(|e| match e {
            SessionError::Failed if value.expose().chars().all(is_js_whitespace) => {
                VaultError::EmptyValue
            }
            e => VaultError::Crypto(e),
        })
    }
}

pub struct Backend<S: Storage, K: Keys> {
    storage: S,
    /// Some while unlocked.
    session: Option<Session<K>>,
    /// Changes on every create, unlock, lock, saved change and set-aside, so
    /// a slow create or unlock that something overtook is thrown away (it
    /// would otherwise bring back lists or keys from before).
    generation: u64,
    /// Convert a v1 vault to v2 when it unlocks (where the storage can).
    convert_v1: bool,
    /// Something to tell the user once, after an unlock.
    notice: Option<Notice>,
    clock: Clock,
}

/// What an unlock has to tell the user, once.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Notice {
    /// The vault was converted to v2, and the v1 file kept as `kept`. The
    /// page keeps `marker` (localStorage `still-converted-v2`), so an old v1
    /// copy asks before it opens.
    Upgraded { marker: String, kept: String },
    /// Converting failed; the vault is unchanged (v1), and converting is
    /// tried again only after a restart (a new backend).
    UpgradeFailed,
}

impl<S: Storage, K: Keys> Backend<S, K> {
    pub fn new(storage: S, clock: Clock) -> Self {
        Self {
            storage,
            session: None,
            generation: 0,
            convert_v1: true,
            notice: None,
            clock,
        }
    }

    pub fn storage(&self) -> &S {
        &self.storage
    }

    /// Whether to convert a v1 vault to v2 when it unlocks (on by default).
    /// Off after the user chose to open an old v1 copy as it is.
    pub fn set_convert_v1(&mut self, convert: bool) {
        self.convert_v1 = convert;
    }

    /// What the last unlock has to tell the user, once.
    pub fn take_notice(&mut self) -> Option<Notice> {
        self.notice.take()
    }

    /// Whether keys are held; unlike `status`, this never reads storage.
    pub fn is_unlocked(&self) -> bool {
        self.session.is_some()
    }

    pub fn status(&self) -> Status {
        if self.session.is_some() {
            Status::Unlocked
        } else if self.storage.unreadable() {
            Status::Unreadable
        } else if self.has_stored_vault() {
            Status::Locked
        } else if self.has_orphaned_data() {
            Status::Orphaned
        } else {
            Status::Empty
        }
    }

    fn has_stored_vault(&self) -> bool {
        self.storage.v2().is_some()
            || (self.storage.get(keys::MASTER_KEY).is_some()
                && self.storage.get(keys::SALT).is_some())
    }

    /// Vault data that a new vault would bury: a lone key or salt, or any Lens data.
    fn has_orphaned_data(&self) -> bool {
        if self.has_stored_vault() {
            return false;
        }
        if self.storage.get(keys::MASTER_KEY).is_some() || self.storage.get(keys::SALT).is_some() {
            return true;
        }
        [keys::LENSES, keys::BIN].iter().any(|key| {
            self.storage
                .get(key)
                .is_some_and(|raw| js_trim(&raw) != "[]")
        })
    }

    // ---- create -------------------------------------------------------------

    /// Refuses while a vault or orphaned data is stored, so existing data is never buried.
    pub fn prepare_create(&self) -> Result<CreatePlan, VaultError> {
        if self.storage.unreadable() || self.has_stored_vault() || self.has_orphaned_data() {
            return Err(VaultError::VaultExists);
        }
        Ok(CreatePlan {
            generation: self.generation,
            v2: self.storage.creates_v2(),
        })
    }

    /// Saves the new vault and unlocks it. If a Lock (or another create or
    /// unlock) happened during the password step, the vault is still saved
    /// but stays locked.
    pub fn finish_create(
        &mut self,
        plan: CreatePlan,
        created: Result<Created<K>, SessionError>,
    ) -> Result<(), VaultError> {
        let created = created.map_err(VaultError::Crypto)?;
        self.prepare_create()?;
        let (keys, format) = match created {
            Created::V1(keys, blob, salt) => {
                let changes = [
                    (keys::MASTER_KEY.to_owned(), Some(blob.clone())),
                    (keys::SALT.to_owned(), Some(salt.clone())),
                    // Kept for the v1 format; the PIN option never worked and has been removed.
                    (keys::HAS_PIN.to_owned(), Some("false".to_owned())),
                ];
                self.storage
                    .write(&changes)
                    .map_err(|_| VaultError::StorageFailed)?;
                let format = Format::V1 {
                    master_key: blob,
                    salt,
                };
                (keys, format)
            }
            Created::V2(keys, file) => {
                self.storage
                    .write_v2(&file)
                    .map_err(|_| VaultError::StorageFailed)?;
                let raw = v2::Body {
                    lenses: "[]".into(),
                    bin: "[]".into(),
                };
                (keys, Format::V2 { file, raw })
            }
        };
        if plan.generation == self.generation {
            self.generation += 1;
            self.session = Some(Session::new(keys, format));
        }
        Ok(())
    }

    /// All of create in one call (the password step runs here).
    pub fn create(&mut self, password: &SecretText) -> Result<(), VaultError> {
        let plan = self.prepare_create()?;
        let created = plan.create::<K>(password);
        self.finish_create(plan, created)
    }

    // ---- unlock and lock ------------------------------------------------------

    pub fn prepare_unlock(&self) -> Result<UnlockPlan, UnlockFailure> {
        if let Some(file) = self.storage.v2() {
            return Ok(UnlockPlan {
                generation: self.generation,
                source: Source::V2 { file },
            });
        }
        // Each value is read once here, and the lists, the key and what a
        // conversion compares all come from these reads. (The storage may load
        // the file anew for each; a conversion re-checks every value against
        // the file before it replaces it.)
        let read: Vec<(String, Option<String>)> = keys::ALL
            .iter()
            .map(|key| ((*key).to_owned(), self.storage.get(key)))
            .collect();
        let value = |key: &str| {
            read.iter()
                .find(|(k, _)| k == key)
                .and_then(|(_, v)| v.clone())
        };
        let (Some(blob), Some(salt)) = (value(keys::MASTER_KEY), value(keys::SALT)) else {
            return Err(UnlockFailure::NoVault);
        };
        if !is_v1_master_key(&blob, &salt) {
            return Err(UnlockFailure::UnreadableData);
        }
        // Saving any change would overwrite an unreadable list, so don't open.
        let (lenses_raw, bin_raw) = (value(keys::LENSES), value(keys::BIN));
        let stored = match (
            parse_list(lenses_raw.as_deref()),
            parse_list(bin_raw.as_deref()),
        ) {
            (Ok(lenses), Ok(bin)) => Lists { lenses, bin },
            _ => return Err(UnlockFailure::UnreadableData),
        };
        wrapped_keys(&stored)?;
        Ok(UnlockPlan {
            generation: self.generation,
            source: Source::V1 {
                stored,
                encrypted_master_key: blob,
                salt,
                raw: v2::Body {
                    lenses: lenses_raw.unwrap_or_else(|| "[]".to_owned()),
                    bin: bin_raw.unwrap_or_else(|| "[]".to_owned()),
                },
                expected: read,
                convert: self.convert_v1 && self.storage.converts_v1(),
            },
        })
    }

    /// Takes the opened keys. If a Lock (or a create or another unlock)
    /// happened during the password step, they are thrown away.
    pub fn finish_unlock(
        &mut self,
        plan: UnlockPlan,
        opened: Result<Opened<K>, SessionError>,
    ) -> Result<(), UnlockFailure> {
        if matches!(opened, Err(SessionError::Corrupt)) && matches!(plan.source, Source::V2 { .. })
        {
            self.storage.mark_damaged();
        }
        let opened = opened.map_err(|e| match e {
            SessionError::WrongPassword => UnlockFailure::WrongPassword,
            SessionError::Corrupt => UnlockFailure::UnreadableData,
            _ => UnlockFailure::Failed,
        })?;
        // Overtaken by a Lock, a saved change or a set-aside: these lists
        // (and keys) may be out of date, so they're never installed.
        if plan.generation != self.generation {
            return Err(UnlockFailure::Failed);
        }
        let (mut format, expected) = match (plan.source, opened.raw) {
            (Source::V2 { file }, Some(raw)) => (Format::V2 { file, raw }, Vec::new()),
            (
                Source::V1 {
                    expected,
                    encrypted_master_key,
                    salt,
                    ..
                },
                None,
            ) => {
                let format = Format::V1 {
                    master_key: encrypted_master_key,
                    salt,
                };
                (format, expected)
            }
            // The password step opens the format the plan read; never otherwise.
            _ => return Err(UnlockFailure::Failed),
        };
        self.generation += 1;
        // Convert before anything is saved, so the Archive purge below is
        // already saved in v2. A failure leaves the vault as it was (v1), and
        // isn't tried again until Still starts again: each try costs a second
        // Argon2id step and shows an error.
        self.notice = match opened.converted {
            None => None,
            Some(Ok((file, body))) => match self.storage.convert_to_v2(&file, &expected) {
                Ok(kept) => {
                    let marker = conversion_marker(&file, (self.clock)());
                    format = Format::V2 { file, raw: body };
                    Some(Notice::Upgraded { marker, kept })
                }
                Err(_) => Some(Notice::UpgradeFailed),
            },
            Some(Err(_)) => Some(Notice::UpgradeFailed),
        };
        if self.notice == Some(Notice::UpgradeFailed) {
            self.convert_v1 = false;
        }
        self.session = Some(Session::new(opened.keys, format));
        self.open_lists(opened.stored, &opened.opened);
        Ok(())
    }

    /// All of unlock in one call (the password step runs here).
    pub fn unlock(&mut self, password: &SecretText) -> Result<(), UnlockFailure> {
        let plan = self.prepare_unlock()?;
        let opened = plan.open::<K>(password);
        self.finish_unlock(plan, opened)
    }

    /// Takes the lists as unlocked. A Lens whose key didn't open stays exactly
    /// as stored, so saving writes it back unchanged; it just isn't shown.
    /// Then the Archive's expired entries are purged, and that is saved.
    fn open_lists(&mut self, stored: Lists, opened: &[bool]) {
        let Some(session) = self.session.as_mut() else {
            return;
        };
        let count = stored.lenses.len();
        session.readable.clear();
        let readable = &mut session.readable;
        let mut open = |(i, lens): (usize, Value)| -> Value {
            if !opened[i] {
                return lens;
            }
            if let Some(id) = id_of(&lens) {
                readable.insert(id.to_owned());
            }
            // `{...lens, items: lens.items ?? []}`
            match lens.get("items") {
                Some(items) if !items.is_null() => lens,
                _ => with_field(&lens, "items", Value::Array(vec![])),
            }
        };
        let lenses = stored
            .lenses
            .into_iter()
            .enumerate()
            .map(&mut open)
            .collect();
        let bin = stored
            .bin
            .into_iter()
            .enumerate()
            .map(|(i, lens)| open((count + i, lens)))
            .collect();
        session.lists = Lists { lenses, bin };
        let purged = model::purge_expired(&session.lists.bin, (self.clock)());
        if purged.len() != session.lists.bin.len() {
            let change = Change {
                lenses: None,
                bin: Some(purged),
            };
            // Unlocking still succeeds if this fails; the purge runs again next time.
            let _ = self.write(change);
        }
    }

    /// Hides everything at once and drops the keys, which zero themselves.
    pub fn lock(&mut self) {
        self.generation += 1;
        self.session = None;
    }

    // ---- reading ----------------------------------------------------------------

    pub fn view(&self) -> View {
        let Some(session) = &self.session else {
            return View {
                lenses: Vec::new(),
                bin: Vec::new(),
                unreadable: 0,
            };
        };
        let readable = |lens: &&Value| id_of(lens).is_some_and(|id| session.readable.contains(id));
        let all = session.lists.lenses.iter().chain(&session.lists.bin);
        View {
            lenses: session
                .lists
                .lenses
                .iter()
                .filter(readable)
                .map(to_view)
                .collect(),
            bin: session
                .lists
                .bin
                .iter()
                .filter(readable)
                .map(|lens| {
                    let mut view = to_view(lens);
                    view["purgeAt"] =
                        model::purge_at(lens).map_or(Value::Null, |ms| time::to_iso(ms).into());
                    view
                })
                .collect(),
            unreadable: all.filter(|lens| !readable(lens)).count(),
        }
    }

    /// A secret's value, from either list (the first Lens with that id).
    pub fn reveal_item(&self, lens_id: &str, item_id: &str) -> Result<SecretText, VaultError> {
        let session = self.session()?;
        let lens = session
            .lists
            .lenses
            .iter()
            .chain(&session.lists.bin)
            .find(|l| id_of(l) == Some(lens_id));
        let item = lens
            .and_then(|lens| items_of(lens).iter().find(|i| id_of(i) == Some(item_id)))
            .ok_or(VaultError::UnknownItem)?;
        let blob = item
            .get("encryptedValue")
            .and_then(Value::as_str)
            .unwrap_or("");
        session
            .keys
            .decrypt_item(lens_id, blob)
            .map_err(VaultError::Crypto)
    }

    // ---- changes ------------------------------------------------------------------

    fn session(&self) -> Result<&Session<K>, VaultError> {
        self.session.as_ref().ok_or(VaultError::Locked)
    }

    /// The unlocked session, for a change to a stored Lens: refused while
    /// locked, or if that Lens's key didn't open.
    fn session_for(&self, lens_id: &str) -> Result<&Session<K>, VaultError> {
        let session = self.session()?;
        session.refuse_hidden(lens_id)?;
        Ok(session)
    }

    /// Saves the lists a change produced, in one write, then makes them
    /// current. On failure nothing changes.
    fn write(&mut self, change: Change) -> Result<(), VaultError> {
        let session = self.session.as_mut().ok_or(VaultError::Locked)?;
        match &mut session.format {
            Format::V2 { file, raw } => {
                if !change.is_empty() {
                    // Only onto this vault's own file: another vault's (a
                    // backup put back, a synced copy) would end up with
                    // neither's key fitting.
                    let on_disk = self.storage.v2().ok_or(VaultError::WriteFailed)?;
                    if on_disk.kdf != file.kdf || on_disk.master_key != file.master_key {
                        return Err(VaultError::WriteFailed);
                    }
                    // A list the change leaves alone is written back exactly as stored.
                    let body = v2::Body {
                        lenses: change
                            .lenses
                            .as_deref()
                            .map_or_else(|| raw.lenses.clone(), write_list),
                        bin: change
                            .bin
                            .as_deref()
                            .map_or_else(|| raw.bin.clone(), write_list),
                    };
                    let sealed = session.keys.seal_v2(file, &body);
                    self.storage
                        .write_v2(&sealed)
                        .map_err(|_| VaultError::WriteFailed)?;
                    *file = sealed;
                    *raw = body;
                }
            }
            Format::V1 { master_key, salt } => {
                let mut writes = Vec::new();
                if let Some(lenses) = &change.lenses {
                    writes.push((keys::LENSES.to_owned(), Some(write_list(lenses))));
                }
                if let Some(bin) = &change.bin {
                    writes.push((keys::BIN.to_owned(), Some(write_list(bin))));
                }
                if !writes.is_empty() {
                    // Only onto this vault's own values, as for v2 above.
                    if self.storage.get(keys::MASTER_KEY).as_ref() != Some(master_key)
                        || self.storage.get(keys::SALT).as_ref() != Some(salt)
                    {
                        return Err(VaultError::WriteFailed);
                    }
                    self.storage
                        .write(&writes)
                        .map_err(|_| VaultError::WriteFailed)?;
                }
            }
        }
        self.generation += 1;
        if let Some(lenses) = change.lenses {
            session.lists.lenses = lenses;
        }
        if let Some(bin) = change.bin {
            session.lists.bin = bin;
        }
        Ok(())
    }

    pub fn create_lens(&mut self, name: &str) -> Result<String, VaultError> {
        let session = self.session.as_mut().ok_or(VaultError::Locked)?;
        let id = new_id();
        let encrypted_master_key = session.keys.new_lens_key(&id);
        let lens = json!({
            "id": id,
            "name": js_trim(name),
            "createdAt": time::to_iso((self.clock)()),
            "itemCount": 0,
            "encryptedMasterKey": encrypted_master_key,
            "items": [],
        });
        let change = model::add_lens(&session.lists, lens);
        self.write(change)?;
        if let Some(session) = self.session.as_mut() {
            session.readable.insert(id.clone());
        }
        Ok(id)
    }

    pub fn add_item(
        &mut self,
        lens_id: &str,
        label: &str,
        item_type: &str,
        value: &SecretText,
    ) -> Result<(), VaultError> {
        let session = self.session_for(lens_id)?;
        let lens = session
            .active_lens(lens_id)
            .ok_or(VaultError::UnknownLens)?;
        let encrypted_value = session.encrypt(lens_id, value)?;
        let mut items = items_of(lens).to_vec();
        items.push(json!({
            "id": new_id(),
            "label": label,
            "type": item_type,
            "encryptedValue": encrypted_value,
        }));
        let change = model::set_items(&session.lists, lens_id, items);
        self.write(change)
    }

    /// Changes a secret in place (same id and position). Without a new
    /// value, the stored one is kept byte for byte.
    pub fn update_item(
        &mut self,
        lens_id: &str,
        item_id: &str,
        label: &str,
        item_type: &str,
        value: Option<&SecretText>,
    ) -> Result<(), VaultError> {
        let session = self.session_for(lens_id)?;
        let lens = session.active_lens(lens_id);
        let items = lens.map(items_of).unwrap_or_default();
        let item = items
            .iter()
            .find(|i| id_of(i) == Some(item_id))
            .ok_or(VaultError::UnknownItem)?;
        let label = js_trim(label);
        if label.is_empty() {
            return Err(VaultError::EmptyLabel);
        }
        let encrypted_value = match value {
            Some(value) => Value::String(session.encrypt(lens_id, value)?),
            None => item.get("encryptedValue").cloned().unwrap_or(Value::Null),
        };
        let items = items
            .iter()
            .map(|i| {
                if id_of(i) != Some(item_id) {
                    return i.clone();
                }
                let i = with_field(i, "label", Value::String(label.to_owned()));
                let i = with_field(&i, "type", Value::String(item_type.to_owned()));
                with_field(&i, "encryptedValue", encrypted_value.clone())
            })
            .collect();
        let change = model::set_items(&session.lists, lens_id, items);
        self.write(change)
    }

    pub fn delete_item(&mut self, lens_id: &str, item_id: &str) -> Result<(), VaultError> {
        let session = self.session_for(lens_id)?;
        let lens = session
            .active_lens(lens_id)
            .ok_or(VaultError::UnknownLens)?;
        // A Lens stored without an items list stays exactly as stored. (Only
        // an unreadable one can be, and those are refused above.)
        if !lens.get("items").is_some_and(Value::is_array) {
            return Err(VaultError::UnknownItem);
        }
        let items = items_of(lens);
        let deleted = items
            .iter()
            .position(|i| id_of(i) == Some(item_id))
            .map(|index| Deleted {
                lens_id: lens_id.to_owned(),
                item: items[index].clone(),
                index,
                at_ms: (self.clock)(),
            });
        let kept = items
            .iter()
            .filter(|i| id_of(i) != Some(item_id))
            .cloned()
            .collect();
        let change = model::set_items(&session.lists, lens_id, kept);
        self.write(change)?;
        if let (Some(session), Some(deleted)) = (self.session.as_mut(), deleted) {
            session.deleted = Some(deleted);
        }
        Ok(())
    }

    /// Puts back the secret deleted last, exactly as it was stored (the same
    /// id, label, type and encrypted value), at the position it had, or at
    /// the end if the Lens has fewer secrets now. Only within RESTORE_MS of
    /// the delete, and only once; a later delete replaces it, and lock
    /// forgets it. Saved like any change: on failure nothing changes.
    pub fn restore_item(&mut self, lens_id: &str, item_id: &str) -> Result<(), VaultError> {
        let now = (self.clock)();
        let session = self.session_for(lens_id)?;
        let deleted = session
            .deleted
            .as_ref()
            .filter(|d| d.lens_id == lens_id && id_of(&d.item) == Some(item_id))
            .filter(|d| (0..RESTORE_MS).contains(&(now - d.at_ms)))
            .ok_or(VaultError::UnknownItem)?;
        let lens = session
            .active_lens(lens_id)
            .ok_or(VaultError::UnknownLens)?;
        let mut items = items_of(lens).to_vec();
        if items.iter().any(|i| id_of(i) == Some(item_id)) {
            return Err(VaultError::UnknownItem);
        }
        items.insert(deleted.index.min(items.len()), deleted.item.clone());
        let change = model::set_items(&session.lists, lens_id, items);
        self.write(change)?;
        if let Some(session) = self.session.as_mut() {
            session.deleted = None;
        }
        Ok(())
    }

    pub fn rename_lens(&mut self, lens_id: &str, name: &str) -> Result<(), VaultError> {
        let session = self.session_for(lens_id)?;
        session
            .active_lens(lens_id)
            .ok_or(VaultError::UnknownLens)?;
        if js_trim(name).is_empty() {
            return Err(VaultError::EmptyName);
        }
        let change = model::rename_lens(&session.lists, lens_id, name);
        self.write(change)
    }

    pub fn forget_lens(&mut self, lens_id: &str) -> Result<(), VaultError> {
        let change = model::forget_lens(&self.session_for(lens_id)?.lists, lens_id, (self.clock)());
        self.write(change)
    }

    pub fn restore_lens(&mut self, lens_id: &str) -> Result<(), VaultError> {
        let change = model::restore_lens(&self.session_for(lens_id)?.lists, lens_id);
        self.write(change)
    }

    pub fn delete_lens_forever(&mut self, lens_id: &str) -> Result<(), VaultError> {
        let change = model::delete_lens_forever(&self.session_for(lens_id)?.lists, lens_id);
        self.write(change)
    }

    // ---- changing the master password -------------------------------------------

    /// What a password change starts from: the vault as last saved. v2 only.
    pub fn prepare_change_password(&self) -> Result<ChangePlan, VaultError> {
        let session = self.session()?;
        let Format::V2 { file, raw } = &session.format else {
            return Err(VaultError::NeedsUpgrade);
        };
        Ok(ChangePlan {
            generation: self.generation,
            file: file.clone(),
            body: v2::Body {
                lenses: raw.lenses.clone(),
                bin: raw.bin.clone(),
            },
        })
    }

    /// Saves the vault under its new password. Refused, with nothing written,
    /// if the vault was locked or changed during the password step (the new
    /// file would hold lists from before), if the new file isn't this vault,
    /// or if the file on disk is another vault's. Returns the other kept
    /// copies that may still open with the old password.
    pub fn finish_change_password(
        &mut self,
        plan: ChangePlan,
        changed: Result<(K, v2::File), SessionError>,
    ) -> Result<Vec<String>, VaultError> {
        let (keys, file) = changed.map_err(VaultError::Crypto)?;
        let session = self.session.as_mut().ok_or(VaultError::Locked)?;
        if plan.generation != self.generation || !keys.same_app_key(&session.keys) {
            return Err(VaultError::WriteFailed);
        }
        let Format::V2 { file: current, .. } = &session.format else {
            return Err(VaultError::NeedsUpgrade);
        };
        let on_disk = self.storage.v2().ok_or(VaultError::WriteFailed)?;
        if on_disk.kdf != current.kdf || on_disk.master_key != current.master_key {
            return Err(VaultError::WriteFailed);
        }
        let kept = self
            .storage
            .write_rekeyed_v2(&file)
            .map_err(|_| VaultError::WriteFailed)?;
        session.format = Format::V2 {
            file,
            raw: plan.body,
        };
        self.generation += 1;
        Ok(kept)
    }

    /// All of a password change in one call (the password step runs here).
    pub fn change_password(
        &mut self,
        current: &SecretText,
        new: &SecretText,
        strength: Strength,
    ) -> Result<Vec<String>, VaultError> {
        let plan = self.prepare_change_password()?;
        let changed = plan.change::<K>(current, new, strength);
        self.finish_change_password(plan, changed)
    }

    // ---- set-aside ------------------------------------------------------------------

    /// Keeps a copy of every stored vault value under a new name, then
    /// removes the originals, so a new vault can be created. Nothing is
    /// deleted, and copies from an earlier set-aside are never overwritten:
    /// if the time-based prefix is taken, a number is added. Returns the prefix.
    pub fn set_aside(&mut self) -> Result<String, VaultError> {
        let base = format!("still-set-aside-{}-", time::to_iso((self.clock)()));
        let taken = self.storage.keys();
        let prefix = std::iter::once(base.clone())
            .chain((2..).map(|n| format!("{base}{n}-")))
            .find(|prefix| !taken.iter().any(|key| key.starts_with(prefix.as_str())))
            .expect("some prefix is free");
        // Copies and removals go in one write: all of it happens or none of it.
        let mut changes = Vec::new();
        for key in keys::ALL {
            if let Some(value) = self.storage.get(key) {
                changes.push((format!("{prefix}{key}"), Some(value)));
                changes.push((key.to_owned(), None));
            }
        }
        self.storage
            .write(&changes)
            .map_err(|_| VaultError::StorageFailed)?;
        self.generation += 1;
        Ok(prefix)
    }
}

/// The conversion marker: when, and a fingerprint of the converted file.
fn conversion_marker(file: &v2::File, now_ms: i64) -> String {
    let fingerprint: String = sodium::sha256(file.to_json().as_bytes())
        .iter()
        .map(|b| format!("{b:02x}"))
        .collect();
    serde_json::json!({ "convertedAt": time::to_iso(now_ms), "fingerprint": fingerprint })
        .to_string()
}

/// 128 random bits in hex. v0.1.0's ids (`Date.now().toString(36)`) are kept as they are.
fn new_id() -> String {
    let mut bytes = [0u8; 16];
    sodium::random_bytes(&mut bytes);
    bytes.iter().map(|b| format!("{b:02x}")).collect()
}

/// `{...value, key: field}`: an existing key keeps its place, a new one goes last.
fn with_field(value: &Value, key: &str, field: Value) -> Value {
    let mut map: Map<String, Value> = value.as_object().cloned().unwrap_or_default();
    map.insert(key.to_owned(), field);
    Value::Object(map)
}

/// A Lens's items, or none if it has no items list.
fn items_of(lens: &Value) -> &[Value] {
    lens.get("items")
        .and_then(Value::as_array)
        .map_or(&[], Vec::as_slice)
}

fn to_view(lens: &Value) -> Value {
    let field = |value: &Value, key: &str| value.get(key).cloned().unwrap_or(Value::Null);
    let items: Vec<Value> = items_of(lens)
        .iter()
        .map(|i| json!({ "id": field(i, "id"), "label": field(i, "label"), "type": field(i, "type") }))
        .collect();
    let mut view = json!({
        "id": field(lens, "id"),
        "name": field(lens, "name"),
        "createdAt": field(lens, "createdAt"),
        "itemCount": field(lens, "itemCount"),
        "items": items,
    });
    if let Some(deleted_at) = lens.get("deletedAt").filter(|v| is_truthy(v)) {
        view["deletedAt"] = deleted_at.clone();
    }
    view
}

/// JavaScript truthiness of a JSON value.
fn is_truthy(value: &Value) -> bool {
    match value {
        Value::Null => false,
        Value::Bool(b) => *b,
        Value::Number(n) => n.as_f64().is_some_and(|f| f != 0.0),
        Value::String(s) => !s.is_empty(),
        Value::Array(_) | Value::Object(_) => true,
    }
}
