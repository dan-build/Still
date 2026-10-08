//! The commands the webview may call (see capabilities/default.json). Each
//! is a thin wrapper over vault.rs. Passwords and values arriving here are
//! wrapped in SecretText at once, so they're zeroed when dropped. Every
//! command counts as activity for auto-lock.

use std::sync::Arc;
use std::time::{Instant, SystemTime};

use serde::{Serialize, Serializer};
use serde_json::{json, Value};
use still_core::session::{SecretText, SessionError, Unlocked};
use still_core::vault::backend::{Status, UnlockFailure};
use tauri::State;

use crate::autolock::AutoLock;
use crate::clipboard::ClipboardGuard;
use crate::store::{AppStore, Loaded, StoreError, Values};
use crate::vault::{self, state, CommandError, Revealed, Vault};

/// Every command, as named in build.rs and the capability.
#[cfg(test)]
pub const ALL: [&str; 18] = [
    "vault_create",
    "vault_unlock",
    "vault_lock",
    "vault_touch",
    "item_copy",
    "storage_load",
    "storage_import_legacy",
    "vault_state",
    "vault_set_aside",
    "lens_create",
    "lens_rename",
    "lens_forget",
    "lens_restore",
    "lens_delete",
    "item_add",
    "item_update",
    "item_delete",
    "item_reveal",
];

/// Creates a vault and unlocks it. Argon2id runs twice (the new key is
/// checked before it's stored), outside the backend's lock.
#[tauri::command]
pub async fn vault_create(
    vault: State<'_, Vault>,
    autolock: State<'_, AutoLock>,
    password: String,
) -> Result<Value, CommandError> {
    let password = SecretText::from(password);
    let plan = vault.backend().prepare_create()?;
    let created = tauri::async_runtime::spawn_blocking(move || Unlocked::create(&password))
        .await
        .unwrap_or(Err(SessionError::Failed));
    // Activity first, so the watcher never sees a new session as idle.
    autolock.touch(SystemTime::now());
    let mut backend = vault.backend();
    backend.finish_create(plan, created)?;
    Ok(state(&backend))
}

/// Unlocks the vault: {ok: true, state} or {ok: false, reason}. Argon2id
/// runs outside the backend's lock; a Lock meanwhile wins.
#[tauri::command]
pub async fn vault_unlock(
    vault: State<'_, Vault>,
    autolock: State<'_, AutoLock>,
    password: String,
) -> Result<Value, CommandError> {
    let password = SecretText::from(password);
    let failed = |reason: UnlockFailure| json!({ "ok": false, "reason": reason.code() });
    let plan = match vault.backend().prepare_unlock() {
        Ok(plan) => plan,
        Err(reason) => return Ok(failed(reason)),
    };
    let (plan, opened) = tauri::async_runtime::spawn_blocking(move || {
        let opened = plan.open::<Unlocked>(&password);
        (plan, opened)
    })
    .await
    .map_err(|_| CommandError("failed"))?;
    autolock.touch(SystemTime::now());
    let mut backend = vault.backend();
    Ok(match backend.finish_unlock(plan, opened) {
        Ok(()) => json!({ "ok": true, "state": state(&backend) }),
        Err(reason) => failed(reason),
    })
}

/// Locks at once, or as soon as a change under way has finished.
#[tauri::command]
pub fn vault_lock(vault: State<'_, Vault>, clipboard: State<'_, ClipboardGuard>) {
    vault.backend().lock();
    clipboard.clear_now();
}

/// The UI reports activity (clicks, typing, scrolling), at most every few seconds.
#[tauri::command]
pub fn vault_touch(autolock: State<'_, AutoLock>) {
    autolock.touch(SystemTime::now());
}

/// Puts a secret's value straight onto the clipboard; it never goes to the
/// webview. It's cleared after 30 seconds (see clipboard.rs).
#[tauri::command]
pub fn item_copy(
    vault: State<'_, Vault>,
    clipboard: State<'_, ClipboardGuard>,
    autolock: State<'_, AutoLock>,
    lens_id: String,
    item_id: String,
) -> Result<(), CommandError> {
    autolock.touch(SystemTime::now());
    let value = vault.backend().reveal_item(&lens_id, &item_id)?;
    clipboard
        .copy(&value, Instant::now())
        .map_err(|_| CommandError("failed"))
}

/// A storage failure the UI may see: a fixed code.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum StorageError {
    /// Another copy of Still holds the vault.
    AlreadyOpen,
    Store(StoreError),
}

impl Serialize for StorageError {
    fn serialize<S: Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
        serializer.serialize_str(match self {
            Self::AlreadyOpen => "already-open",
            Self::Store(e) => e.code(),
        })
    }
}

/// Whether there is a vault file: "nothing", "values", "unreadable" or
/// "already-open". Never the values themselves: those stay in Rust.
#[tauri::command]
pub fn storage_load(store: State<'_, Arc<AppStore>>) -> &'static str {
    if store.already_open {
        return "already-open";
    }
    match store.store().load() {
        Loaded::Nothing => "nothing",
        Loaded::Values(_) => "values",
        Loaded::Unreadable => "unreadable",
    }
}

/// Creates the vault file from the values an older version kept in
/// localStorage. Refuses if a vault file already exists.
#[tauri::command]
pub fn storage_import_legacy(
    store: State<'_, Arc<AppStore>>,
    values: Values,
) -> Result<(), StorageError> {
    if store.already_open {
        return Err(StorageError::AlreadyOpen);
    }
    store
        .store()
        .import_legacy(values)
        .map_err(StorageError::Store)
}

// ---- the vault backend's commands --------------------------------------------
//
// Each returns the vault's state ({status, view}) after it ran, or a code.
// The page names Lenses and secrets by id; values arrive only to be saved.

/// The status and the view, as they are now.
#[tauri::command]
pub fn vault_state(vault: State<'_, Vault>) -> Value {
    state(&vault.backend())
}

/// Copies every stored vault value under a new name, then removes the
/// originals, so a new vault can be created. Returns the prefix used.
///
/// Only for vault data that can't be opened (the recovery screen): a vault
/// with its key and salt is never moved aside.
#[tauri::command]
pub fn vault_set_aside(vault: State<'_, Vault>) -> Result<String, CommandError> {
    let mut backend = vault.backend();
    if backend.status() != Status::Orphaned {
        return Err(CommandError("not-orphaned"));
    }
    Ok(backend.set_aside()?)
}

/// The page's input, checked before it reaches the backend: the UI never
/// sends a blank name or label, or a type it doesn't know.
fn check_name(name: &str, error: &'static str) -> Result<(), CommandError> {
    if name.chars().all(still_core::crypto::is_js_whitespace) {
        Err(CommandError(error))
    } else {
        Ok(())
    }
}

fn check_type(item_type: &str) -> Result<(), CommandError> {
    if ["password", "key", "note"].contains(&item_type) {
        Ok(())
    } else {
        Err(CommandError("unknown-type"))
    }
}

/// Runs a change to the vault and returns the new state.
fn change(
    vault: &Vault,
    autolock: &AutoLock,
    run: impl FnOnce(&mut vault::AppBackend) -> Result<(), still_core::vault::backend::VaultError>,
) -> Result<Value, CommandError> {
    autolock.touch(SystemTime::now());
    let mut backend = vault.backend();
    run(&mut backend)?;
    Ok(state(&backend))
}

#[tauri::command]
pub fn lens_create(
    vault: State<'_, Vault>,
    autolock: State<'_, AutoLock>,
    name: String,
) -> Result<Value, CommandError> {
    autolock.touch(SystemTime::now());
    check_name(&name, "empty-name")?;
    let mut backend = vault.backend();
    let id = backend.create_lens(&name)?;
    Ok(json!({ "id": id, "state": state(&backend) }))
}

#[tauri::command]
pub fn lens_rename(
    vault: State<'_, Vault>,
    autolock: State<'_, AutoLock>,
    lens_id: String,
    name: String,
) -> Result<Value, CommandError> {
    change(&vault, &autolock, |b| b.rename_lens(&lens_id, &name))
}

#[tauri::command]
pub fn lens_forget(
    vault: State<'_, Vault>,
    autolock: State<'_, AutoLock>,
    lens_id: String,
) -> Result<Value, CommandError> {
    change(&vault, &autolock, |b| b.forget_lens(&lens_id))
}

#[tauri::command]
pub fn lens_restore(
    vault: State<'_, Vault>,
    autolock: State<'_, AutoLock>,
    lens_id: String,
) -> Result<Value, CommandError> {
    change(&vault, &autolock, |b| b.restore_lens(&lens_id))
}

#[tauri::command]
pub fn lens_delete(
    vault: State<'_, Vault>,
    autolock: State<'_, AutoLock>,
    lens_id: String,
) -> Result<Value, CommandError> {
    change(&vault, &autolock, |b| b.delete_lens_forever(&lens_id))
}

#[tauri::command]
pub fn item_add(
    vault: State<'_, Vault>,
    autolock: State<'_, AutoLock>,
    lens_id: String,
    label: String,
    item_type: String,
    value: String,
) -> Result<Value, CommandError> {
    let value = SecretText::from(value);
    check_name(&label, "empty-label")?;
    check_type(&item_type)?;
    change(&vault, &autolock, |b| {
        b.add_item(&lens_id, &label, &item_type, &value)
    })
}

/// Without a value, the stored one is kept as it is.
#[tauri::command]
pub fn item_update(
    vault: State<'_, Vault>,
    autolock: State<'_, AutoLock>,
    lens_id: String,
    item_id: String,
    label: String,
    item_type: String,
    value: Option<String>,
) -> Result<Value, CommandError> {
    let value = value.map(SecretText::from);
    check_type(&item_type)?;
    change(&vault, &autolock, |b| {
        b.update_item(&lens_id, &item_id, &label, &item_type, value.as_ref())
    })
}

#[tauri::command]
pub fn item_delete(
    vault: State<'_, Vault>,
    autolock: State<'_, AutoLock>,
    lens_id: String,
    item_id: String,
) -> Result<Value, CommandError> {
    change(&vault, &autolock, |b| b.delete_item(&lens_id, &item_id))
}

/// The one command that sends a value to the page, to show it.
#[tauri::command]
pub fn item_reveal(
    vault: State<'_, Vault>,
    autolock: State<'_, AutoLock>,
    lens_id: String,
    item_id: String,
) -> Result<Revealed, CommandError> {
    autolock.touch(SystemTime::now());
    Ok(Revealed(vault.backend().reveal_item(&lens_id, &item_id)?))
}

#[cfg(test)]
mod tests {
    use super::*;

    // The UI never sends these; a page that does gets a code, not a change.
    #[test]
    fn refuses_blank_names_and_unknown_types_from_the_page() {
        assert_eq!(check_name("Work", "empty-name"), Ok(()));
        for blank in ["", "   ", "\u{FEFF}\u{3000}", "\n\t"] {
            assert_eq!(
                check_name(blank, "empty-name"),
                Err(CommandError("empty-name"))
            );
        }
        for known in ["password", "key", "note"] {
            assert_eq!(check_type(known), Ok(()));
        }
        for unknown in ["", "card", "Password", "note "] {
            assert_eq!(check_type(unknown), Err(CommandError("unknown-type")));
        }
    }
}
