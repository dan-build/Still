//! The commands the webview may call (see capabilities/default.json). Each
//! is a thin wrapper over vault.rs. Passwords and values arriving here are
//! wrapped in SecretText at once, so they're zeroed when dropped. Every
//! command counts as activity for auto-lock.

use std::time::{Instant, SystemTime};

use serde::Deserialize;
use still_core::session::{SecretText, SessionError, Unlocked};
use tauri::State;

use crate::autolock::AutoLock;
use crate::clipboard::ClipboardGuard;
use crate::vault::{self, CreatedVault, Revealed, VaultError, VaultSession};

/// Every command, as named in build.rs and the capability.
#[cfg(test)]
pub const ALL: [&str; 8] = [
    "vault_create",
    "vault_unlock",
    "vault_lock",
    "vault_touch",
    "lens_new_key",
    "item_encrypt",
    "item_decrypt",
    "item_copy",
];

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WrappedLensKeyArg {
    id: String,
    encrypted_master_key: String,
}

/// Argon2id takes seconds and 1 GiB, so it runs off the async runtime.
async fn blocking<T: Send + 'static>(
    work: impl FnOnce() -> Result<T, VaultError> + Send + 'static,
) -> Result<T, VaultError> {
    tauri::async_runtime::spawn_blocking(work)
        .await
        .unwrap_or(Err(VaultError(SessionError::Failed)))
}

#[tauri::command]
pub async fn vault_create(
    session: State<'_, VaultSession>,
    autolock: State<'_, AutoLock>,
    password: String,
) -> Result<CreatedVault, VaultError> {
    let password = SecretText::from(password);
    let (unlocked, encrypted_master_key, salt) =
        blocking(move || Ok(Unlocked::create(&password)?)).await?;
    // Activity first, so the watcher never sees a new session as idle.
    autolock.touch(SystemTime::now());
    session.install(unlocked);
    Ok(CreatedVault {
        encrypted_master_key,
        salt,
    })
}

#[tauri::command]
pub async fn vault_unlock(
    session: State<'_, VaultSession>,
    autolock: State<'_, AutoLock>,
    encrypted_master_key: String,
    salt: String,
    password: String,
    lenses: Vec<WrappedLensKeyArg>,
) -> Result<Vec<bool>, VaultError> {
    let password = SecretText::from(password);
    let lenses: Vec<(String, String)> = lenses
        .into_iter()
        .map(|l| (l.id, l.encrypted_master_key))
        .collect();
    let (unlocked, opened) =
        blocking(move || vault::open(&encrypted_master_key, &salt, &password, &lenses)).await?;
    autolock.touch(SystemTime::now());
    session.install(unlocked);
    Ok(opened)
}

#[tauri::command]
pub fn vault_lock(session: State<'_, VaultSession>, clipboard: State<'_, ClipboardGuard>) {
    session.lock();
    clipboard.clear_now();
}

/// The UI reports activity (clicks, typing, scrolling), at most every few seconds.
#[tauri::command]
pub fn vault_touch(autolock: State<'_, AutoLock>) {
    autolock.touch(SystemTime::now());
}

#[tauri::command]
pub fn lens_new_key(
    session: State<'_, VaultSession>,
    autolock: State<'_, AutoLock>,
    lens_id: String,
) -> Result<String, VaultError> {
    autolock.touch(SystemTime::now());
    session.new_lens_key(&lens_id)
}

#[tauri::command]
pub fn item_encrypt(
    session: State<'_, VaultSession>,
    autolock: State<'_, AutoLock>,
    lens_id: String,
    plaintext: String,
) -> Result<String, VaultError> {
    autolock.touch(SystemTime::now());
    session.encrypt_item(&lens_id, &SecretText::from(plaintext))
}

#[tauri::command]
pub fn item_decrypt(
    session: State<'_, VaultSession>,
    autolock: State<'_, AutoLock>,
    lens_id: String,
    encrypted_value: String,
) -> Result<Revealed, VaultError> {
    autolock.touch(SystemTime::now());
    session.decrypt_item(&lens_id, &encrypted_value)
}

/// Decrypts an item straight onto the clipboard; the value never goes back to
/// the webview. It's cleared after 30 seconds (see clipboard.rs).
#[tauri::command]
pub fn item_copy(
    session: State<'_, VaultSession>,
    clipboard: State<'_, ClipboardGuard>,
    autolock: State<'_, AutoLock>,
    lens_id: String,
    encrypted_value: String,
) -> Result<(), VaultError> {
    autolock.touch(SystemTime::now());
    let value = session.decrypt_item(&lens_id, &encrypted_value)?;
    clipboard
        .copy(&value.0, Instant::now())
        .map_err(|_| VaultError(SessionError::Failed))
}
