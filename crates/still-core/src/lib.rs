//! Still's vault cryptography: the v1 encrypted format, byte for byte the
//! same as src/platform/crypto/crypto.ts, built on libsodium.
//!
//! Only the `sodium` module may use `unsafe` (it wraps libsodium's C API);
//! everything else is safe Rust.

#![deny(unsafe_code)]

pub mod crypto;
pub mod error;
pub mod format;
pub mod session;
pub mod sodium;

pub use crypto::Key;
pub use error::Error;
