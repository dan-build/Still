//! Safe wrappers around libsodium's C API. This is the only module allowed
//! to use `unsafe`; everything it exposes is safe to call.

#![allow(unsafe_code)]

use libsodium_sys as ffi;
use std::ffi::CStr;
use std::os::raw::{c_char, c_int};
use std::ptr;
use std::sync::OnceLock;

/// libsodium's ORIGINAL base64 variant (standard alphabet, padded), as used by the app.
const BASE64_ORIGINAL: c_int = ffi::sodium_base64_VARIANT_ORIGINAL as c_int;

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

/// Encodes bytes as standard, padded base64, exactly as libsodium-wrappers'
/// `to_base64(…, ORIGINAL)` does.
pub fn to_base64(bin: &[u8]) -> String {
    // SAFETY: sodium_base64_encoded_len only computes a size.
    let len = unsafe { ffi::sodium_base64_encoded_len(bin.len(), BASE64_ORIGINAL) };
    let mut out = vec![0u8; len];
    // SAFETY: `out` has room for `len` bytes, the encoded length including the
    // NUL terminator; `bin` is valid for `bin.len()` bytes.
    unsafe {
        ffi::sodium_bin2base64(
            out.as_mut_ptr() as *mut c_char,
            len,
            bin.as_ptr(),
            bin.len(),
            BASE64_ORIGINAL,
        );
    }
    out.truncate(len.saturating_sub(1));
    // libsodium only writes ASCII base64 characters.
    String::from_utf8(out).unwrap_or_default()
}

/// Decodes standard, padded base64 (libsodium's ORIGINAL variant). Returns
/// None unless the whole input is valid base64, with nothing left over.
pub fn from_base64(b64: &str) -> Option<Vec<u8>> {
    let mut out = vec![0u8; b64.len() / 4 * 3 + 3];
    let mut bin_len = 0usize;
    let mut end: *const c_char = ptr::null();
    // SAFETY: `out` is writable for its length; `b64` is valid for its length;
    // libsodium writes at most `out.len()` bytes and sets `end` inside `b64`.
    let rc = unsafe {
        ffi::sodium_base642bin(
            out.as_mut_ptr(),
            out.len(),
            b64.as_ptr() as *const c_char,
            b64.len(),
            ptr::null(),
            &mut bin_len,
            &mut end,
            BASE64_ORIGINAL,
        )
    };
    let consumed = end as usize == b64.as_ptr() as usize + b64.len();
    if rc != 0 || !consumed {
        return None;
    }
    out.truncate(bin_len);
    Some(out)
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

    #[test]
    fn base64_matches_the_standard_padded_alphabet() {
        assert_eq!(to_base64(&[]), "");
        assert_eq!(to_base64(&[0, 1, 2]), "AAEC");
        assert_eq!(to_base64(&[0, 1]), "AAE=");
        assert_eq!(to_base64(&[0xfb, 0xff]), "+/8=");
        assert_eq!(from_base64("AAE="), Some(vec![0, 1]));
        assert_eq!(from_base64("+/8="), Some(vec![0xfb, 0xff]));
    }

    #[test]
    fn base64_rejects_anything_else() {
        for bad in ["AAE", "AA-_", "AAE=x", "AA E=", "*", "AAEC=", "===="] {
            assert_eq!(from_base64(bad), None, "{bad:?}");
        }
    }
}
