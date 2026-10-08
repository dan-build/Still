//! One background thread that ticks about once a second. It locks the vault
//! when auto-lock says so (telling the UI why), and clears a copied secret
//! from the clipboard once it's due.

use std::time::{Duration, Instant, SystemTime};

use tauri::{AppHandle, Emitter, Manager};

use crate::autolock::AutoLock;
use crate::clipboard::ClipboardGuard;
use crate::vault::Vault;

const TICK: Duration = Duration::from_secs(1);

/// Sent to the main window when the vault locked itself; the payload is the
/// reason, "idle" or "sleep".
pub const LOCKED_EVENT: &str = "vault-locked";

pub fn start(app: AppHandle) {
    std::thread::Builder::new()
        .name("still-watcher".into())
        .spawn(move || loop {
            std::thread::sleep(TICK);
            let vault = app.state::<Vault>();
            let clipboard = app.state::<ClipboardGuard>();
            let unlocked = vault.backend().is_unlocked();
            let reason = app
                .state::<AutoLock>()
                .check(Instant::now(), SystemTime::now(), unlocked);
            if let Some(reason) = reason {
                vault.backend().lock();
                clipboard.clear_now();
                let _ = app.emit_to("main", LOCKED_EVENT, reason);
            }
            clipboard.tick(Instant::now());
        })
        .expect("can start the watcher thread");
}
