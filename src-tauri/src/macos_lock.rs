//! macOS: lock the vault as the computer goes to sleep or the screen locks,
//! instead of only noticing a sleep after waking (autolock.rs, which stays as
//! the fallback). Registering for those notifications means calling
//! Objective-C, which Rust can't check, so this module and still-core's
//! sodium.rs are the only ones allowed `unsafe` code. It never touches keys,
//! values or the vault file: it only calls the same lock as everything else.

#![allow(unsafe_code)]

use std::ptr::NonNull;

use block2::RcBlock;
use objc2_app_kit::{NSWorkspace, NSWorkspaceWillSleepNotification};
use objc2_foundation::{NSDistributedNotificationCenter, NSNotification, NSString};
use tauri::AppHandle;

use crate::autolock::Reason;
use crate::watcher::lock_now;

/// The distributed notification macOS posts when the screen locks.
const SCREEN_LOCKED: &str = "com.apple.screenIsLocked";

/// Starts observing for the rest of the app's life. Called once, from setup,
/// on the main thread, whose run loop delivers both notifications.
pub fn watch(app: &AppHandle) {
    let on_sleep = {
        let app = app.clone();
        RcBlock::new(move |_: NonNull<NSNotification>| lock_now(&app, Reason::Sleep))
    };
    let on_screen = {
        let app = app.clone();
        RcBlock::new(move |_: NonNull<NSNotification>| lock_now(&app, Reason::Screen))
    };
    let workspace = NSWorkspace::sharedWorkspace().notificationCenter();
    let distributed = NSDistributedNotificationCenter::defaultCenter();
    let screen_locked = NSString::from_str(SCREEN_LOCKED);
    // SAFETY: NSWorkspaceWillSleepNotification is an immutable NSString that
    // AppKit defines for the life of the process. addObserverForName asks for
    // a block that is safe to call from the posting thread: these blocks only
    // hold an AppHandle (Send + Sync) and call lock_now, which takes its own
    // locks. With no object and no queue, every such notification is delivered
    // on the thread that posts it. The returned observers are kept (leaked) on
    // purpose: Still observes until it quits, and macOS releases them then.
    unsafe {
        let sleep = workspace.addObserverForName_object_queue_usingBlock(
            Some(NSWorkspaceWillSleepNotification),
            None,
            None,
            &on_sleep,
        );
        let screen = distributed.addObserverForName_object_queue_usingBlock(
            Some(&screen_locked),
            None,
            None,
            &on_screen,
        );
        std::mem::forget((sleep, screen));
    }
}
