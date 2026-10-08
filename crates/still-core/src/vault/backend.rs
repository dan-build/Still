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
}

impl Status {
    pub fn code(self) -> &'static str {
        match self {
            Self::Empty => "empty",
            Self::Locked => "locked",
            Self::Unlocked => "unlocked",
            Self::Orphaned => "orphaned",
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
    stored: Lists,
    encrypted_master_key: String,
    salt: String,
    /// One entry per stored Lens (Lenses, then Archive): its id and wrapped
    /// key, when both are strings.
    wrapped: Vec<Option<(String, String)>>,
}

impl UnlockPlan {
    /// The slow part: Argon2id, then every Lens key. Needs no backend.
    pub fn open<K: Keys>(&self, password: &SecretText) -> Result<(K, Vec<bool>), SessionError> {
        let lenses: Vec<WrappedLensKey<'_>> = self
            .wrapped
            .iter()
            .flatten()
            .map(|(id, key)| WrappedLensKey {
                id,
                encrypted_master_key: key,
            })
            .collect();
        let (keys, opened) = K::open(&self.encrypted_master_key, &self.salt, password, &lenses)?;
        // Spread the results back over every entry; those not passed didn't open.
        let mut results = opened.into_iter();
        let all = self
            .wrapped
            .iter()
            .map(|entry| entry.is_some() && results.next().unwrap_or(false))
            .collect();
        Ok((keys, all))
    }
}

/// What `prepare_create` checked, for `finish_create`.
pub struct CreatePlan {
    generation: u64,
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

pub struct Backend<S: Storage, K: Keys> {
    storage: S,
    /// Some while unlocked.
    keys: Option<K>,
    lists: Lists,
    /// Lens ids whose key opened. Others are kept but not shown.
    readable: HashSet<String>,
    /// Changes on every create, unlock, lock, saved change and set-aside, so
    /// a slow create or unlock that something overtook is thrown away (it
    /// would otherwise bring back lists or keys from before).
    generation: u64,
    clock: Clock,
}

impl<S: Storage, K: Keys> Backend<S, K> {
    pub fn new(storage: S, clock: Clock) -> Self {
        Self {
            storage,
            keys: None,
            lists: Lists::default(),
            readable: HashSet::new(),
            generation: 0,
            clock,
        }
    }

    pub fn storage(&self) -> &S {
        &self.storage
    }

    pub fn status(&self) -> Status {
        if self.keys.is_some() {
            Status::Unlocked
        } else if self.has_stored_vault() {
            Status::Locked
        } else if self.has_orphaned_data() {
            Status::Orphaned
        } else {
            Status::Empty
        }
    }

    fn has_stored_vault(&self) -> bool {
        self.storage.get(keys::MASTER_KEY).is_some() && self.storage.get(keys::SALT).is_some()
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
        if self.has_stored_vault() || self.has_orphaned_data() {
            return Err(VaultError::VaultExists);
        }
        Ok(CreatePlan {
            generation: self.generation,
        })
    }

    /// Saves the new vault and unlocks it. If a Lock (or another create or
    /// unlock) happened during the password step, the vault is still saved
    /// but stays locked.
    pub fn finish_create(
        &mut self,
        plan: CreatePlan,
        created: Result<(K, String, String), SessionError>,
    ) -> Result<(), VaultError> {
        let (keys, blob, salt) = created.map_err(VaultError::Crypto)?;
        self.prepare_create()?;
        let changes = [
            (keys::MASTER_KEY.to_owned(), Some(blob)),
            (keys::SALT.to_owned(), Some(salt)),
            // Kept for the v1 format; the PIN option never worked and has been removed.
            (keys::HAS_PIN.to_owned(), Some("false".to_owned())),
        ];
        self.storage
            .write(&changes)
            .map_err(|_| VaultError::StorageFailed)?;
        if plan.generation == self.generation {
            self.generation += 1;
            self.keys = Some(keys);
            self.lists = Lists::default();
            self.readable.clear();
        }
        Ok(())
    }

    /// All of create in one call (the password step runs here).
    pub fn create(&mut self, password: &SecretText) -> Result<(), VaultError> {
        let plan = self.prepare_create()?;
        self.finish_create(plan, K::create(password))
    }

    // ---- unlock and lock ------------------------------------------------------

    pub fn prepare_unlock(&self) -> Result<UnlockPlan, UnlockFailure> {
        let (Some(blob), Some(salt)) = (
            self.storage.get(keys::MASTER_KEY),
            self.storage.get(keys::SALT),
        ) else {
            return Err(UnlockFailure::NoVault);
        };
        if !is_v1_master_key(&blob, &salt) {
            return Err(UnlockFailure::UnreadableData);
        }
        // Saving any change would overwrite an unreadable list, so don't open.
        let read = |key| parse_list(self.storage.get(key).as_deref());
        let stored = match (read(keys::LENSES), read(keys::BIN)) {
            (Ok(lenses), Ok(bin)) => Lists { lenses, bin },
            _ => return Err(UnlockFailure::UnreadableData),
        };
        let all = stored.lenses.iter().chain(&stored.bin);
        // The TypeScript backend failed outright on a null entry (it read
        // fields of every entry before opening any); kept as it was.
        if all.clone().any(Value::is_null) {
            return Err(UnlockFailure::Failed);
        }
        let wrapped = all
            .map(|lens| {
                let key = lens.get("encryptedMasterKey")?.as_str()?;
                Some((id_of(lens)?.to_owned(), key.to_owned()))
            })
            .collect();
        Ok(UnlockPlan {
            generation: self.generation,
            stored,
            encrypted_master_key: blob,
            salt,
            wrapped,
        })
    }

    /// Takes the opened keys. If a Lock (or a create or another unlock)
    /// happened during the password step, they are thrown away.
    pub fn finish_unlock(
        &mut self,
        plan: UnlockPlan,
        opened: Result<(K, Vec<bool>), SessionError>,
    ) -> Result<(), UnlockFailure> {
        let (keys, opened) = opened.map_err(|e| match e {
            SessionError::WrongPassword => UnlockFailure::WrongPassword,
            SessionError::Corrupt => UnlockFailure::UnreadableData,
            _ => UnlockFailure::Failed,
        })?;
        // Overtaken by a Lock, a saved change or a set-aside: these lists
        // (and keys) may be out of date, so they're never installed.
        if plan.generation != self.generation {
            return Err(UnlockFailure::Failed);
        }
        self.generation += 1;
        self.keys = Some(keys);
        self.open_lists(plan.stored, &opened);
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
        let count = stored.lenses.len();
        self.readable.clear();
        let mut open = |(i, lens): (usize, Value)| -> Value {
            if !opened[i] {
                return lens;
            }
            if let Some(id) = id_of(&lens) {
                self.readable.insert(id.to_owned());
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
        self.lists = Lists { lenses, bin };
        let purged = model::purge_expired(&self.lists.bin, (self.clock)());
        if purged.len() != self.lists.bin.len() {
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
        self.keys = None;
        self.readable.clear();
        self.lists = Lists::default();
    }

    // ---- reading ----------------------------------------------------------------

    pub fn view(&self) -> View {
        let readable = |lens: &&Value| id_of(lens).is_some_and(|id| self.readable.contains(id));
        let all = self.lists.lenses.iter().chain(&self.lists.bin);
        View {
            lenses: self
                .lists
                .lenses
                .iter()
                .filter(readable)
                .map(to_view)
                .collect(),
            bin: self
                .lists
                .bin
                .iter()
                .filter(readable)
                .map(to_view)
                .collect(),
            unreadable: all.filter(|lens| !readable(lens)).count(),
        }
    }

    /// A secret's value, from either list (the first Lens with that id).
    pub fn reveal_item(&self, lens_id: &str, item_id: &str) -> Result<SecretText, VaultError> {
        let keys = self.keys.as_ref().ok_or(VaultError::Locked)?;
        let lens = self
            .lists
            .lenses
            .iter()
            .chain(&self.lists.bin)
            .find(|l| id_of(l) == Some(lens_id));
        let item = lens
            .and_then(|lens| items_of(lens).iter().find(|i| id_of(i) == Some(item_id)))
            .ok_or(VaultError::UnknownItem)?;
        let blob = item
            .get("encryptedValue")
            .and_then(Value::as_str)
            .unwrap_or("");
        keys.decrypt_item(lens_id, blob).map_err(VaultError::Crypto)
    }

    // ---- changes ------------------------------------------------------------------

    fn keys(&self) -> Result<&K, VaultError> {
        self.keys.as_ref().ok_or(VaultError::Locked)
    }

    fn active_lens(&self, lens_id: &str) -> Option<&Value> {
        self.lists.lenses.iter().find(|l| id_of(l) == Some(lens_id))
    }

    /// Encrypts a value for a Lens: its key must have opened, and the value
    /// must not be blank.
    fn encrypt(&self, lens_id: &str, value: &SecretText) -> Result<String, VaultError> {
        self.keys()?
            .encrypt_item(lens_id, value)
            .map_err(|e| match e {
                SessionError::Failed if value.expose().chars().all(is_js_whitespace) => {
                    VaultError::EmptyValue
                }
                e => VaultError::Crypto(e),
            })
    }

    /// Saves the lists a change produced, in one write, then makes them
    /// current. On failure nothing changes.
    fn write(&mut self, change: Change) -> Result<(), VaultError> {
        self.keys()?;
        let mut writes = Vec::new();
        if let Some(lenses) = &change.lenses {
            writes.push((keys::LENSES.to_owned(), Some(write_list(lenses))));
        }
        if let Some(bin) = &change.bin {
            writes.push((keys::BIN.to_owned(), Some(write_list(bin))));
        }
        if !writes.is_empty() {
            self.storage
                .write(&writes)
                .map_err(|_| VaultError::WriteFailed)?;
        }
        self.generation += 1;
        if let Some(lenses) = change.lenses {
            self.lists.lenses = lenses;
        }
        if let Some(bin) = change.bin {
            self.lists.bin = bin;
        }
        Ok(())
    }

    pub fn create_lens(&mut self, name: &str) -> Result<String, VaultError> {
        self.keys()?;
        let id = new_id();
        let encrypted_master_key = self.keys.as_mut().expect("unlocked").new_lens_key(&id);
        let lens = json!({
            "id": id,
            "name": js_trim(name),
            "createdAt": time::to_iso((self.clock)()),
            "itemCount": 0,
            "encryptedMasterKey": encrypted_master_key,
            "items": [],
        });
        self.write(model::add_lens(&self.lists, lens))?;
        self.readable.insert(id.clone());
        Ok(id)
    }

    pub fn add_item(
        &mut self,
        lens_id: &str,
        label: &str,
        item_type: &str,
        value: &SecretText,
    ) -> Result<(), VaultError> {
        self.keys()?;
        let lens = self.active_lens(lens_id).ok_or(VaultError::UnknownLens)?;
        let encrypted_value = self.encrypt(lens_id, value)?;
        let mut items = items_of(lens).to_vec();
        items.push(json!({
            "id": new_id(),
            "label": label,
            "type": item_type,
            "encryptedValue": encrypted_value,
        }));
        self.write(model::set_items(&self.lists, lens_id, items))
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
        self.keys()?;
        let lens = self.active_lens(lens_id);
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
            Some(value) => Value::String(self.encrypt(lens_id, value)?),
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
        self.write(model::set_items(&self.lists, lens_id, items))
    }

    pub fn delete_item(&mut self, lens_id: &str, item_id: &str) -> Result<(), VaultError> {
        self.keys()?;
        let lens = self.active_lens(lens_id).ok_or(VaultError::UnknownLens)?;
        // A Lens stored without an items list (only an unreadable one can be)
        // stays exactly as stored.
        if !lens.get("items").is_some_and(Value::is_array) {
            return Err(VaultError::UnknownItem);
        }
        let items = items_of(lens)
            .iter()
            .filter(|i| id_of(i) != Some(item_id))
            .cloned()
            .collect();
        self.write(model::set_items(&self.lists, lens_id, items))
    }

    pub fn rename_lens(&mut self, lens_id: &str, name: &str) -> Result<(), VaultError> {
        self.keys()?;
        self.active_lens(lens_id).ok_or(VaultError::UnknownLens)?;
        if js_trim(name).is_empty() {
            return Err(VaultError::EmptyName);
        }
        self.write(model::rename_lens(&self.lists, lens_id, name))
    }

    pub fn forget_lens(&mut self, lens_id: &str) -> Result<(), VaultError> {
        self.keys()?;
        self.write(model::forget_lens(&self.lists, lens_id, (self.clock)()))
    }

    pub fn restore_lens(&mut self, lens_id: &str) -> Result<(), VaultError> {
        self.keys()?;
        self.write(model::restore_lens(&self.lists, lens_id))
    }

    pub fn delete_lens_forever(&mut self, lens_id: &str) -> Result<(), VaultError> {
        self.keys()?;
        self.write(model::delete_lens_forever(&self.lists, lens_id))
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
