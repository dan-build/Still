//! Copying a secret. Rust writes it to the clipboard itself (the webview never
//! sees it), marks it for clipboard-history tools to skip, and clears it after
//! 30 seconds, on lock and on quit, but only while the clipboard still holds
//! that secret: anything copied since is left alone.
//!
//! To recognise the secret later it keeps only a keyed BLAKE2b fingerprint,
//! with a key made fresh for each run.

use std::sync::{Mutex, MutexGuard};
use std::time::{Duration, Instant};

use still_core::session::SecretText;
use still_core::sodium;

pub const CLEAR_AFTER: Duration = Duration::from_secs(30);

/// The system clipboard, behind an interface so tests can use a fake one.
pub trait SystemClipboard: Send {
    /// Writes `text`, asking clipboard-history tools not to record it.
    fn set_concealed(&mut self, text: &str) -> Result<(), ()>;
    fn get(&mut self) -> Option<String>;
    fn clear(&mut self) -> Result<(), ()>;
}

/// The real clipboard. Created on first use and kept, because on Linux the
/// clipboard's contents are served for as long as it lives.
#[derive(Default)]
pub struct Arboard(Option<arboard::Clipboard>);

impl Arboard {
    fn clipboard(&mut self) -> Result<&mut arboard::Clipboard, ()> {
        if self.0.is_none() {
            self.0 = arboard::Clipboard::new().ok();
        }
        self.0.as_mut().ok_or(())
    }
}

impl SystemClipboard for Arboard {
    fn set_concealed(&mut self, text: &str) -> Result<(), ()> {
        let set = self.clipboard()?.set();
        #[cfg(target_os = "macos")]
        let set = {
            use arboard::SetExtApple;
            set.exclude_from_history()
        };
        #[cfg(target_os = "windows")]
        let set = {
            use arboard::SetExtWindows;
            set.exclude_from_history().exclude_from_cloud()
        };
        #[cfg(all(unix, not(target_os = "macos")))]
        let set = {
            use arboard::SetExtLinux;
            set.exclude_from_history()
        };
        set.text(text).map_err(|_| ())
    }

    fn get(&mut self) -> Option<String> {
        self.clipboard().ok()?.get_text().ok()
    }

    fn clear(&mut self) -> Result<(), ()> {
        self.clipboard()?.clear().map_err(|_| ())
    }
}

struct Copied {
    fingerprint: [u8; 32],
    clear_at: Instant,
}

struct Inner {
    clipboard: Box<dyn SystemClipboard>,
    copied: Option<Copied>,
}

impl Inner {
    /// Clears the clipboard if it still holds the copied secret. Forgets the
    /// secret unless clearing failed, so the next tick tries again.
    fn clear_if_ours(&mut self, key: &[u8; 32]) {
        let Some(copied) = &self.copied else { return };
        let still_ours = self.clipboard.get().is_some_and(|current| {
            let current = SecretText::from(current);
            let fingerprint = sodium::blake2b_256(current.expose().as_bytes(), Some(key));
            sodium::memeq(&fingerprint, &copied.fingerprint)
        });
        if still_ours && self.clipboard.clear().is_err() {
            return;
        }
        self.copied = None;
    }
}

pub struct ClipboardGuard {
    inner: Mutex<Inner>,
    key: [u8; 32],
}

impl ClipboardGuard {
    pub fn new(clipboard: Box<dyn SystemClipboard>) -> Self {
        let mut key = [0u8; 32];
        sodium::random_bytes(&mut key);
        Self {
            inner: Mutex::new(Inner {
                clipboard,
                copied: None,
            }),
            key,
        }
    }

    // A panic can't leave this half-changed, so a poisoned lock is still usable.
    fn inner(&self) -> MutexGuard<'_, Inner> {
        self.inner.lock().unwrap_or_else(|p| p.into_inner())
    }

    /// Puts `value` on the clipboard, to be cleared at `now + CLEAR_AFTER`.
    pub fn copy(&self, value: &SecretText, now: Instant) -> Result<(), ()> {
        let mut inner = self.inner();
        // A secret copied earlier and still on the clipboard goes first.
        inner.clear_if_ours(&self.key);
        inner.clipboard.set_concealed(value.expose())?;
        inner.copied = Some(Copied {
            fingerprint: sodium::blake2b_256(value.expose().as_bytes(), Some(&self.key)),
            clear_at: now + CLEAR_AFTER,
        });
        Ok(())
    }

    /// On lock and quit: clear the copied secret now, if it's still there.
    pub fn clear_now(&self) {
        self.inner().clear_if_ours(&self.key);
    }

    /// Called about once a second: clears the copied secret once it's due.
    pub fn tick(&self, now: Instant) {
        let mut inner = self.inner();
        if inner.copied.as_ref().is_some_and(|c| now >= c.clear_at) {
            inner.clear_if_ours(&self.key);
        }
    }
}

impl Drop for ClipboardGuard {
    fn drop(&mut self) {
        sodium::memzero(&mut self.key);
    }
}

#[cfg(test)]
pub mod tests {
    use super::*;
    use std::sync::{Arc, Mutex};

    /// A clipboard in memory. `fail_clear` makes clearing fail.
    #[derive(Clone, Default)]
    pub struct FakeClipboard {
        pub text: Arc<Mutex<Option<String>>>,
        pub concealed: Arc<Mutex<bool>>,
        pub fail_clear: Arc<Mutex<bool>>,
    }

    impl FakeClipboard {
        pub fn text(&self) -> Option<String> {
            self.text.lock().unwrap().clone()
        }
        /// Someone copies something else.
        pub fn user_copies(&self, text: &str) {
            *self.text.lock().unwrap() = Some(text.into());
            *self.concealed.lock().unwrap() = false;
        }
    }

    impl SystemClipboard for FakeClipboard {
        fn set_concealed(&mut self, text: &str) -> Result<(), ()> {
            *self.text.lock().unwrap() = Some(text.into());
            *self.concealed.lock().unwrap() = true;
            Ok(())
        }
        fn get(&mut self) -> Option<String> {
            self.text()
        }
        fn clear(&mut self) -> Result<(), ()> {
            if *self.fail_clear.lock().unwrap() {
                return Err(());
            }
            *self.text.lock().unwrap() = None;
            Ok(())
        }
    }

    fn secret(text: &str) -> SecretText {
        SecretText::from(text.to_owned())
    }

    fn guard() -> (ClipboardGuard, FakeClipboard) {
        let fake = FakeClipboard::default();
        (ClipboardGuard::new(Box::new(fake.clone())), fake)
    }

    #[test]
    fn copies_concealed_and_clears_after_30_seconds() {
        let (guard, fake) = guard();
        let start = Instant::now();
        guard.copy(&secret("hunter2"), start).unwrap();
        assert_eq!(fake.text().as_deref(), Some("hunter2"));
        assert!(*fake.concealed.lock().unwrap());

        guard.tick(start + Duration::from_secs(29));
        assert_eq!(fake.text().as_deref(), Some("hunter2"));
        guard.tick(start + CLEAR_AFTER);
        assert_eq!(fake.text(), None);
    }

    #[test]
    fn leaves_anything_copied_since_alone() {
        let (guard, fake) = guard();
        let start = Instant::now();
        guard.copy(&secret("hunter2"), start).unwrap();
        fake.user_copies("my own text");
        guard.tick(start + CLEAR_AFTER);
        guard.clear_now();
        assert_eq!(fake.text().as_deref(), Some("my own text"));
    }

    #[test]
    fn clears_at_once_on_lock_or_quit() {
        let (guard, fake) = guard();
        guard.copy(&secret("hunter2"), Instant::now()).unwrap();
        guard.clear_now();
        assert_eq!(fake.text(), None);
        // Nothing is left to clear afterwards.
        fake.user_copies("later");
        guard.clear_now();
        assert_eq!(fake.text().as_deref(), Some("later"));
    }

    #[test]
    fn a_new_copy_replaces_the_old_one_and_restarts_the_timer() {
        let (guard, fake) = guard();
        let start = Instant::now();
        guard.copy(&secret("first"), start).unwrap();
        guard
            .copy(&secret("second"), start + Duration::from_secs(20))
            .unwrap();
        guard.tick(start + Duration::from_secs(40));
        assert_eq!(fake.text().as_deref(), Some("second"));
        guard.tick(start + Duration::from_secs(50));
        assert_eq!(fake.text(), None);
    }

    #[test]
    fn retries_when_clearing_fails() {
        let (guard, fake) = guard();
        let start = Instant::now();
        guard.copy(&secret("hunter2"), start).unwrap();
        *fake.fail_clear.lock().unwrap() = true;
        guard.tick(start + CLEAR_AFTER);
        assert_eq!(fake.text().as_deref(), Some("hunter2"));
        *fake.fail_clear.lock().unwrap() = false;
        guard.tick(start + CLEAR_AFTER + Duration::from_secs(1));
        assert_eq!(fake.text(), None);
    }
}
