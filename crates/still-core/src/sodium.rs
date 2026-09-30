//! Safe wrappers around libsodium's C API. This is the only module allowed
//! to use `unsafe`; everything it exposes is safe to call.

#![allow(unsafe_code)]

use libsodium_sys as ffi;
use std::ffi::CStr;
use std::sync::OnceLock;

/// libsodium could not be initialised (sodium_init failed).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct InitFailed;

/// Initialises libsodium once per process. Every other wrapper calls this first.
pub fn init() -> Result<(), InitFailed> {
    static READY: OnceLock<bool> = OnceLock::new();
    // SAFETY: sodium_init is safe to call from any thread, any number of times.
    let ok = *READY.get_or_init(|| unsafe { ffi::sodium_init() } >= 0);
    if ok {
        Ok(())
    } else {
        Err(InitFailed)
    }
}

/// The libsodium version this crate was built with, such as "1.0.22".
pub fn version() -> &'static str {
    // SAFETY: returns a pointer to a static, NUL-terminated string.
    unsafe { CStr::from_ptr(ffi::sodium_version_string()) }
        .to_str()
        .unwrap_or("unknown")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn initialises_libsodium_1_0_22() {
        assert_eq!(init(), Ok(()));
        assert_eq!(init(), Ok(()));
        // The same libsodium release as libsodium-wrappers-sumo 0.8.4 in the app.
        assert_eq!(version(), "1.0.22");
    }
}
