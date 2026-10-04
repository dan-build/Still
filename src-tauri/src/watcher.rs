//! One background thread that ticks about once a second: it clears a copied
//! secret from the clipboard once it's due.

use std::time::{Duration, Instant};

use tauri::{AppHandle, Manager};

use crate::clipboard::ClipboardGuard;

const TICK: Duration = Duration::from_secs(1);

pub fn start(app: AppHandle) {
    std::thread::Builder::new()
        .name("still-watcher".into())
        .spawn(move || loop {
            std::thread::sleep(TICK);
            app.state::<ClipboardGuard>().tick(Instant::now());
        })
        .expect("can start the watcher thread");
}
