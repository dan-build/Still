//! Safe wrappers around libsodium's C API. This is the only module allowed
//! to use `unsafe`; everything it exposes is safe to call.

#![allow(unsafe_code)]

use libsodium_sys as ffi;
use std::ffi::CStr;
use std::os::raw::{c_char, c_int, c_ulonglong, c_void};
use std::ptr;
use std::sync::{Mutex, OnceLock};

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

pub const NONCE_BYTES: usize = 24;
pub const TAG_BYTES: usize = 16;

/// Argon2id couldn't run (usually: not enough memory for 1 GiB).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct PasswordHashFailed;

/// A ciphertext failed authentication or was too short to hold a tag.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct AuthFailed;

/// Argon2id v1.3 with libsodium's SENSITIVE limits (4 passes, 1 GiB), 32-byte
/// output: the same call as crypto_pwhash in src/test/reference/crypto.ts.
/// Fails if libsodium can't allocate the memory.
///
/// Runs one at a time per process: each run takes 1 GiB, the app never needs
/// two at once, and it keeps concurrency out of the one computation a vault
/// can't recover from getting wrong.
pub fn argon2id_sensitive(
    out: &mut [u8; 32],
    password: &[u8],
    salt: &[u8; 16],
) -> Result<(), PasswordHashFailed> {
    init().map_err(|_| PasswordHashFailed)?;
    static ONE_AT_A_TIME: Mutex<()> = Mutex::new(());
    let _running = ONE_AT_A_TIME
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner());
    // SAFETY: `out` is writable for 32 bytes, `password` and `salt` are valid
    // for their lengths (salt is crypto_pwhash_SALTBYTES = 16).
    let rc = unsafe {
        ffi::crypto_pwhash(
            out.as_mut_ptr(),
            out.len() as c_ulonglong,
            password.as_ptr() as *const c_char,
            password.len() as c_ulonglong,
            salt.as_ptr(),
            ffi::crypto_pwhash_OPSLIMIT_SENSITIVE as c_ulonglong,
            ffi::crypto_pwhash_MEMLIMIT_SENSITIVE as usize,
            ffi::crypto_pwhash_ALG_ARGON2ID13 as c_int,
        )
    };
    if rc == 0 {
        Ok(())
    } else {
        Err(PasswordHashFailed)
    }
}

/// XChaCha20-Poly1305 (IETF) with no associated data. Returns ciphertext + tag.
pub fn aead_encrypt(message: &[u8], nonce: &[u8; NONCE_BYTES], key: &[u8; 32]) -> Vec<u8> {
    let _ = init();
    let mut sealed = vec![0u8; message.len() + TAG_BYTES];
    let mut sealed_len: c_ulonglong = 0;
    // SAFETY: `sealed` has room for the message plus the 16-byte tag; the
    // other buffers are valid for their lengths; no additional data.
    unsafe {
        ffi::crypto_aead_xchacha20poly1305_ietf_encrypt(
            sealed.as_mut_ptr(),
            &mut sealed_len,
            message.as_ptr(),
            message.len() as c_ulonglong,
            ptr::null(),
            0,
            ptr::null(),
            nonce.as_ptr(),
            key.as_ptr(),
        );
    }
    sealed.truncate(sealed_len as usize);
    sealed
}

/// Opens an XChaCha20-Poly1305 (IETF) ciphertext + tag. Err if it is too short
/// or fails authentication (wrong key or changed bytes).
pub fn aead_decrypt(
    sealed: &[u8],
    nonce: &[u8; NONCE_BYTES],
    key: &[u8; 32],
) -> Result<Vec<u8>, AuthFailed> {
    init().map_err(|_| AuthFailed)?;
    if sealed.len() < TAG_BYTES {
        return Err(AuthFailed);
    }
    let mut message = vec![0u8; sealed.len() - TAG_BYTES];
    let mut message_len: c_ulonglong = 0;
    // SAFETY: `message` has room for the ciphertext length minus the tag; the
    // other buffers are valid for their lengths; no additional data.
    let rc = unsafe {
        ffi::crypto_aead_xchacha20poly1305_ietf_decrypt(
            message.as_mut_ptr(),
            &mut message_len,
            ptr::null_mut(),
            sealed.as_ptr(),
            sealed.len() as c_ulonglong,
            ptr::null(),
            0,
            nonce.as_ptr(),
            key.as_ptr(),
        )
    };
    if rc != 0 {
        memzero(&mut message);
        return Err(AuthFailed);
    }
    message.truncate(message_len as usize);
    Ok(message)
}

/// BLAKE2b-256 of `data` (crypto_generichash), keyed with `key` when one is
/// given. Used to recognise a value later without keeping the value itself.
pub fn blake2b_256(data: &[u8], key: Option<&[u8; 32]>) -> [u8; 32] {
    let _ = init();
    let mut out = [0u8; 32];
    let (key_ptr, key_len) = key.map_or((ptr::null(), 0), |k| (k.as_ptr(), k.len()));
    // SAFETY: `out` is writable for 32 bytes, `data` is readable for its
    // length, and the key pointer is either null with length 0 or valid for 32
    // bytes (within crypto_generichash's 16..=64 key range).
    let rc = unsafe {
        ffi::crypto_generichash(
            out.as_mut_ptr(),
            out.len(),
            data.as_ptr(),
            data.len() as c_ulonglong,
            key_ptr,
            key_len,
        )
    };
    debug_assert_eq!(rc, 0, "crypto_generichash takes these lengths");
    out
}

/// crypto_kdf_derive_from_key: a 32-byte subkey from `key`, `id` and an
/// 8-byte context (keyed BLAKE2b in libsodium).
pub fn kdf_derive(out: &mut [u8; 32], id: u64, context: &[u8; 8], key: &[u8; 32]) {
    let _ = init();
    // SAFETY: `out` is writable for 32 bytes (within crypto_kdf's 16..64),
    // `context` is exactly crypto_kdf_CONTEXTBYTES = 8, `key` is 32 bytes.
    unsafe {
        ffi::crypto_kdf_derive_from_key(
            out.as_mut_ptr(),
            out.len(),
            id,
            context.as_ptr() as *const c_char,
            key.as_ptr(),
        );
    }
}

/// Fills `buf` from the OS CSPRNG via libsodium.
pub fn random_bytes(buf: &mut [u8]) {
    let _ = init();
    // SAFETY: `buf` is writable for its length.
    unsafe { ffi::randombytes_buf(buf.as_mut_ptr() as *mut c_void, buf.len()) }
}

/// A uniformly random u32 (libsodium's randombytes_random, as in crypto.ts).
pub fn random_u32() -> u32 {
    let _ = init();
    // SAFETY: no arguments; returns a value.
    unsafe { ffi::randombytes_random() }
}

/// Constant-time equality of two byte strings (sodium_memcmp). Lengths are
/// not secret: different lengths are simply unequal.
pub fn memeq(a: &[u8], b: &[u8]) -> bool {
    if a.len() != b.len() {
        return false;
    }
    let _ = init();
    // SAFETY: both pointers are valid for `a.len()` bytes.
    unsafe {
        ffi::sodium_memcmp(
            a.as_ptr() as *const c_void,
            b.as_ptr() as *const c_void,
            a.len(),
        ) == 0
    }
}

/// Overwrites `buf` with zeros in a way the compiler won't optimise away.
pub fn memzero(buf: &mut [u8]) {
    // SAFETY: `buf` is writable for its length.
    unsafe { ffi::sodium_memzero(buf.as_mut_ptr() as *mut c_void, buf.len()) }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn initialises_libsodium_1_0_22() {
        assert_eq!(init(), Ok(()));
        assert_eq!(init(), Ok(()));
        // The same libsodium release as libsodium-wrappers-sumo 0.8.4, which
        // v0.1.x shipped and the JS reference tests use.
        assert_eq!(version(), "1.0.22");
    }

    // Reference values from Python's hashlib.blake2b(digest_size=32).
    #[test]
    fn blake2b_256_matches_an_independent_implementation() {
        let hex = |b: [u8; 32]| b.iter().map(|x| format!("{x:02x}")).collect::<String>();
        assert_eq!(
            hex(blake2b_256(b"", None)),
            "0e5751c026e543b2e8ab2eb06099daa1d1e5df47778f7787faab45cdf12fe3a8"
        );
        let key: [u8; 32] = std::array::from_fn(|i| i as u8);
        assert_eq!(
            hex(blake2b_256("Pässwörd 🔐".as_bytes(), Some(&key))),
            "da49d4fefa9c3cf3b9ccd87f3a7a83b532489acaae81791fedf882e31126fdac"
        );
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
