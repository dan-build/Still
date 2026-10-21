//! One background thread that ticks about once a second. It locks the vault
//! when auto-lock says so (telling the UI why), and clears a copied secret
//! from the clipboard once it's due.

use std::time::{Duration, Instant, SystemTime};

use tauri::{AppHandle, Emitter, Manager};

use crate::autolock::{AutoLock, Reason};
use crate::clipboard::ClipboardGuard;
use crate::vault::Vault;

const TICK: Duration = Duration::from_secs(1);

/// Sent to the main window when the vault locked itself; the payload is the
/// reason: "idle", "sleep" or "screen".
pub const LOCKED_EVENT: &str = "vault-locked";

/// Locks an unlocked vault now, clears a copied secret and tells the UI why.
/// Auto-lock calls it, and on macOS so do sleep and screen lock (macos_lock.rs).
pub fn lock_now(app: &AppHandle, reason: Reason) {
    let vault = app.state::<Vault>();
    if !vault.backend().is_unlocked() {
        return;
    }
    vault.backend().lock();
    app.state::<ClipboardGuard>().clear_now();
    let _ = app.emit_to("main", LOCKED_EVENT, reason);
}

pub fn start(app: AppHandle) {
    std::thread::Builder::new()
        .name("still-watcher".into())
        .spawn(move || loop {
            std::thread::sleep(TICK);
            let unlocked = app.state::<Vault>().backend().is_unlocked();
            let reason = app
                .state::<AutoLock>()
                .check(Instant::now(), SystemTime::now(), unlocked);
            if let Some(reason) = reason {
                lock_now(&app, reason);
            }
            app.state::<ClipboardGuard>().tick(Instant::now());
        })
        .expect("can start the watcher thread");
}
