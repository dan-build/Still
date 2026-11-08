//! The commands the webview may call (see capabilities/default.json). Each
//! is a thin wrapper over vault.rs. Passwords and values arriving here are
//! wrapped in SecretText at once, so they're zeroed when dropped. Every
//! command counts as activity for auto-lock.

use std::sync::Arc;
use std::time::Instant;

use serde_json::{json, Value};
use still_core::session::{SecretText, Unlocked};
use still_core::vault::backend::{Notice, Status, Strength, UnlockFailure};
use still_core::vault::backup;
use tauri::{AppHandle, Manager, State};

use crate::autolock::AutoLock;
use crate::clipboard::ClipboardGuard;
use crate::startup;
use crate::store::{AppStore, Values};
use crate::vault::{self, state, ChosenBackup, CommandError, PendingRestore, Revealed, Vault};

/// Every command, as named in build.rs and the capability.
#[cfg(test)]
pub const ALL: [&str; 28] = [
    "vault_create",
    "vault_unlock",
    "vault_lock",
    "vault_touch",
    "item_copy",
    "startup_open",
    "startup_use_old_copy",
    "startup_open_old_format",
    "startup_restore_v1",
    "vault_state",
    "vault_set_aside",
    "vault_change_password",
    "lens_create",
    "lens_rename",
    "lens_forget",
    "lens_restore",
    "lens_delete",
    "item_add",
    "item_update",
    "item_delete",
    "item_restore",
    "backup_save",
    "restore_choose",
    "restore_check",
    "restore_confirm",
    "kept_list",
    "kept_trash",
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
    check_new_password(&password)?;
    let password = SecretText::from(password);
    let plan = vault.backend().prepare_create()?;
    let (plan, created) = tauri::async_runtime::spawn_blocking(move || {
        let created = plan.create::<Unlocked>(&password);
        (plan, created)
    })
    .await
    .map_err(|_| CommandError("failed"))?;
    // Activity first, so the watcher never sees a new session as idle.
    autolock.touch(Instant::now());
    let mut backend = vault.backend();
    backend.finish_create(plan, created)?;
    Ok(state(&backend))
}

/// Changes the master password, given the current one, the new one (the
/// same rules as creating a vault) and whether to use stronger Argon2id
/// settings. Argon2id runs three times, outside the backend's lock; a Lock
/// or a save meanwhile wins. Returns {state, olderCopies}: the kept copies
/// that may still open with the old password.
#[tauri::command]
pub async fn vault_change_password(
    vault: State<'_, Vault>,
    autolock: State<'_, AutoLock>,
    current: String,
    new: String,
    stronger: bool,
) -> Result<Value, CommandError> {
    check_new_password(&new)?;
    let current = SecretText::from(current);
    let new = SecretText::from(new);
    let strength = if stronger {
        Strength::Stronger
    } else {
        Strength::Standard
    };
    let plan = vault.backend().prepare_change_password()?;
    let (plan, changed) = tauri::async_runtime::spawn_blocking(move || {
        let changed = plan.change::<Unlocked>(&current, &new, strength);
        (plan, changed)
    })
    .await
    .map_err(|_| CommandError("failed"))?;
    autolock.touch(Instant::now());
    let mut backend = vault.backend();
    let kept = backend.finish_change_password(plan, changed)?;
    Ok(json!({ "state": state(&backend), "olderCopies": kept }))
}

/// Unlocks the vault: {ok: true, state} or {ok: false, reason, canRestore?}. Argon2id
/// runs outside the backend's lock; a Lock meanwhile wins.
#[tauri::command]
pub async fn vault_unlock(
    vault: State<'_, Vault>,
    store: State<'_, Arc<AppStore>>,
    autolock: State<'_, AutoLock>,
    password: String,
) -> Result<Value, CommandError> {
    let password = SecretText::from(password);
    // Damaged data may come with a kept copy to put back (startup_restore_v1).
    let failed = |reason: UnlockFailure| {
        let mut result = json!({ "ok": false, "reason": reason.code() });
        if reason == UnlockFailure::UnreadableData {
            result["canRestore"] = json!(store.store().restore_source().is_some());
        }
        result
    };
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
    autolock.touch(Instant::now());
    let mut backend = vault.backend();
    Ok(match backend.finish_unlock(plan, opened) {
        Ok(()) => {
            let mut unlocked = json!({ "ok": true, "state": state(&backend) });
            // The first unlock after updating converts the vault to v2 (the
            // store records it, so an old v1 copy put back later asks first).
            match backend.take_notice() {
                Some(Notice::Upgraded { kept }) => {
                    unlocked["notice"] = json!("upgraded");
                    unlocked["kept"] = json!(kept);
                }
                Some(Notice::UpgradeFailed) => unlocked["notice"] = json!("upgrade-failed"),
                None => {}
            }
            unlocked
        }
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
    autolock.touch(Instant::now());
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
    autolock.touch(Instant::now());
    let value = vault.backend().reveal_item(&lens_id, &item_id)?;
    clipboard
        .copy(&value, Instant::now())
        .map_err(|_| CommandError("failed"))
}

// ---- start-up ----------------------------------------------------------------

/// Opens the vault file, or moves an older version's vault into it once (see
/// startup.rs). The page sends what it found in localStorage: the values an
/// older version kept, and the two markers versions up to 0.8 kept there
/// (taken into the record once). It gets back {kind, notice?, movedAt?, ...}.
#[tauri::command]
pub fn startup_open(
    vault: State<'_, Vault>,
    store: State<'_, Arc<AppStore>>,
    legacy: Values,
    marker: Option<String>,
    converted: Option<String>,
) -> Value {
    let startup = startup::open(
        &store,
        legacy,
        marker.as_deref(),
        converted.as_deref(),
        now_ms(),
    );
    // An old-format file in a converted vault's place is never converted
    // unless the user says so; Rust holds to that whatever the page does.
    if matches!(startup, startup::Startup::OldFormat { .. }) {
        vault.backend().set_convert_v1(false);
    }
    startup.to_json()
}

/// The user's choice when the vault file is in the old format although the
/// vault was converted: open it as it is, or open and upgrade it (sealing
/// this copy, whatever it holds, into v2: their decision).
#[tauri::command]
pub fn startup_open_old_format(vault: State<'_, Vault>, upgrade: bool) -> Value {
    vault.backend().set_convert_v1(upgrade);
    json!({ "kind": "ready" })
}

/// The user's choice when the vault file can't be opened: put back the
/// newest copy Still kept (the unreadable file is kept too).
#[tauri::command]
pub fn startup_restore_v1(store: State<'_, Arc<AppStore>>) -> Value {
    startup::restore_kept(&store).to_json()
}

/// The user's choice when the moved vault file has gone: bring back the
/// older copy from localStorage.
#[tauri::command]
pub fn startup_use_old_copy(store: State<'_, Arc<AppStore>>, legacy: Values) -> Value {
    startup::move_old_copy(&store, legacy, now_ms()).to_json()
}

fn now_ms() -> i64 {
    (still_core::vault::backend::system_clock())()
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

/// The page's rules for a new master password, kept in Rust too: at least 8
/// characters, counted as JavaScript counts them (UTF-16 code units), and not
/// only spaces (JavaScript's whitespace).
fn check_new_password(password: &str) -> Result<(), CommandError> {
    if password.chars().all(still_core::crypto::is_js_whitespace) {
        Err(CommandError("password-blank"))
    } else if password.encode_utf16().count() < 8 {
        Err(CommandError("password-too-short"))
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
    autolock.touch(Instant::now());
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
    autolock.touch(Instant::now());
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

/// Puts back the secret deleted last (Undo), within 30 seconds of the delete.
#[tauri::command]
pub fn item_restore(
    vault: State<'_, Vault>,
    autolock: State<'_, AutoLock>,
    lens_id: String,
    item_id: String,
) -> Result<Value, CommandError> {
    change(&vault, &autolock, |b| b.restore_item(&lens_id, &item_id))
}

/// The one command that sends a value to the page, to show it.
#[tauri::command]
pub fn item_reveal(
    vault: State<'_, Vault>,
    autolock: State<'_, AutoLock>,
    lens_id: String,
    item_id: String,
) -> Result<Revealed, CommandError> {
    autolock.touch(Instant::now());
    Ok(Revealed(vault.backend().reveal_item(&lens_id, &item_id)?))
}

// ---- backups ------------------------------------------------------------------

/// The largest file Still reads as a backup (a vault is a few KiB per Lens).
const BACKUP_MAX_BYTES: u64 = 64 << 20;

/// The native dialogs' parent: Still's window, so they open as its sheets.
fn dialog(app: &AppHandle) -> rfd::AsyncFileDialog {
    let dialog = rfd::AsyncFileDialog::new().add_filter("Still vault", &["json"]);
    match app.get_webview_window("main") {
        Some(window) => dialog.set_parent(&window),
        None => dialog,
    }
}

/// Saves a backup of the unlocked vault where the user chooses: the vault
/// file itself, already encrypted. Returns {saved: file name} or {saved:
/// null} when the dialog was cancelled.
#[tauri::command]
pub async fn backup_save(
    app: AppHandle,
    vault: State<'_, Vault>,
    store: State<'_, Arc<AppStore>>,
    autolock: State<'_, AutoLock>,
) -> Result<Value, CommandError> {
    let file = vault.backend().backup_file()?;
    let today = &still_core::vault::time::to_iso(now_ms())[..10];
    let chosen = dialog(&app)
        .set_file_name(format!("Still backup {today}.json"))
        .save_file()
        .await;
    autolock.touch(Instant::now());
    let Some(chosen) = chosen else {
        return Ok(json!({ "saved": null }));
    };
    store
        .store()
        .write_backup(&file, chosen.path())
        .map_err(|_| CommandError("write-failed"))?;
    Ok(json!({ "saved": chosen.file_name() }))
}

/// Whether a backup may replace the vault now: while it's unlocked, or when
/// there's no vault that could be unlocked (none, orphaned data, or a file
/// that can't be read). A locked vault must be unlocked first.
fn may_restore(vault: &Vault) -> Result<(), CommandError> {
    let backend = vault.backend();
    match backend.status() {
        Status::Unlocked | Status::Empty | Status::Orphaned | Status::Unreadable => Ok(()),
        Status::Locked => Err(CommandError("unlock-first")),
    }
}

/// Chooses a backup to restore: a native open dialog, then the file is read
/// as a v2 vault (nothing is replaced yet). Returns {name, modifiedAt} or
/// {name: null} when the dialog was cancelled.
#[tauri::command]
pub async fn restore_choose(
    app: AppHandle,
    vault: State<'_, Vault>,
    pending: State<'_, PendingRestore>,
) -> Result<Value, CommandError> {
    may_restore(&vault)?;
    let Some(chosen) = dialog(&app).pick_file().await else {
        return Ok(json!({ "name": null }));
    };
    let path = chosen.path();
    let meta = std::fs::metadata(path).map_err(|_| CommandError("not-a-vault"))?;
    if meta.len() > BACKUP_MAX_BYTES {
        return Err(CommandError("not-a-vault"));
    }
    let text = std::fs::read_to_string(path).map_err(|_| CommandError("not-a-vault"))?;
    let file = backup::parse(&text).map_err(|e| CommandError(e.code()))?;
    *pending.get() = Some(ChosenBackup {
        file,
        checked: false,
    });
    let modified = meta
        .modified()
        .ok()
        .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
        .and_then(|d| i64::try_from(d.as_millis()).ok());
    Ok(json!({ "name": chosen.file_name(), "modifiedAt": modified }))
}

/// Opens the chosen backup with its password (Argon2id with its own
/// settings, outside any lock) and returns what it holds: {lenses,
/// secrets, archived}.
#[tauri::command]
pub async fn restore_check(
    pending: State<'_, PendingRestore>,
    password: String,
) -> Result<Value, CommandError> {
    let file = pending
        .get()
        .as_ref()
        .map(|chosen| chosen.file.clone())
        .ok_or(CommandError("nothing-chosen"))?;
    let password = SecretText::from(password);
    let checked = file.clone();
    let summary = tauri::async_runtime::spawn_blocking(move || {
        backup::check::<Unlocked>(&checked, &password)
    })
    .await
    .map_err(|_| CommandError("failed"))?
    .map_err(|e| CommandError(e.code()))?;
    // Mark it checked only if it is still the backup chosen.
    if let Some(chosen) = pending.get().as_mut().filter(|c| c.file == file) {
        chosen.checked = true;
    }
    Ok(
        json!({ "lenses": summary.lenses, "secrets": summary.secrets, "archived": summary.archived }),
    )
}

/// Replaces the vault with the checked backup, keeping the current vault
/// file (and its backup) first, and locks: the restored vault opens with
/// the backup's password. Returns {kept}: the replaced vault's name, if any.
#[tauri::command]
pub fn restore_confirm(
    vault: State<'_, Vault>,
    store: State<'_, Arc<AppStore>>,
    pending: State<'_, PendingRestore>,
    clipboard: State<'_, ClipboardGuard>,
) -> Result<Value, CommandError> {
    may_restore(&vault)?;
    let mut chosen = pending.get();
    let file = match chosen.as_ref() {
        Some(c) if c.checked => c.file.clone(),
        Some(_) => return Err(CommandError("not-checked")),
        None => return Err(CommandError("nothing-chosen")),
    };
    let mut backend = vault.backend();
    backend.lock();
    clipboard.clear_now();
    let kept = store
        .store()
        .restore_backup(&file)
        .map_err(|_| CommandError("write-failed"))?;
    *chosen = None;
    Ok(json!({ "kept": kept }))
}

/// The copies Still kept next to the vault, while it's unlocked:
/// [{name, modifiedAt, size}].
#[tauri::command]
pub fn kept_list(
    vault: State<'_, Vault>,
    store: State<'_, Arc<AppStore>>,
) -> Result<Value, CommandError> {
    if !vault.backend().is_unlocked() {
        return Err(CommandError("locked"));
    }
    let kept: Vec<Value> = store
        .store()
        .kept_details()
        .into_iter()
        .map(|(name, modified, size)| json!({ "name": name, "modifiedAt": modified, "size": size }))
        .collect();
    Ok(Value::Array(kept))
}

/// Moves one kept copy to the Trash, while the vault is unlocked, and
/// returns the list that's left.
#[tauri::command]
pub fn kept_trash(
    vault: State<'_, Vault>,
    store: State<'_, Arc<AppStore>>,
    name: String,
) -> Result<Value, CommandError> {
    if !vault.backend().is_unlocked() {
        return Err(CommandError("locked"));
    }
    store
        .store()
        .trash_kept(&name)
        .map_err(|_| CommandError("trash-failed"))?;
    kept_list(vault, store)
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

    // The create-password screen already stops these; Rust holds to the
    // same rules whatever the page sends.
    #[test]
    fn refuses_a_new_master_password_the_page_would_refuse() {
        for blank in [
            "",
            "        ",
            "\u{3000}\u{3000}\u{3000}\u{3000}\u{3000}\u{3000}\u{3000}\u{3000}",
        ] {
            assert_eq!(
                check_new_password(blank),
                Err(CommandError("password-blank"))
            );
        }
        for short in ["a", "seven77", " short "] {
            assert_eq!(
                check_new_password(short),
                Err(CommandError("password-too-short"))
            );
        }
        // Counted in UTF-16 code units, as the page's password.length does:
        // four emoji are eight units.
        assert_eq!(check_new_password("🔐🔐🔐🔐"), Ok(()));
        assert_eq!(
            check_new_password("🔐🔐🔐"),
            Err(CommandError("password-too-short"))
        );
        assert_eq!(check_new_password("eight888"), Ok(()));
        assert_eq!(check_new_password("  spaced out  "), Ok(()));
    }
}
