//! Still's vault cryptography: the v1 encrypted format, byte for byte the
//! same as app/lib/crypto.ts, built on libsodium.
//!
//! Only the `sodium` module may use `unsafe` (it wraps libsodium's C API);
//! everything else is safe Rust.

#![deny(unsafe_code)]
