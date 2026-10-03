// Shared helpers for the fixture tests (not a test file itself).
#![allow(dead_code)]

use std::sync::{Mutex, MutexGuard};

use serde_json::Value;

/// Each Argon2id run takes 1 GiB. Tests in one file run in parallel, so
/// tests that derive keys hold this to run one derivation at a time (CI's
/// macOS runner has 7 GB).
pub fn argon2_one_at_a_time() -> MutexGuard<'static, ()> {
    static ARGON2: Mutex<()> = Mutex::new(());
    ARGON2
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
}

pub fn fixture(path: &str) -> Value {
    let file = format!("{}/../../fixtures/{path}", env!("CARGO_MANIFEST_DIR"));
    serde_json::from_str(&std::fs::read_to_string(&file).expect("fixture exists"))
        .expect("valid JSON")
}

pub fn hex(value: &Value) -> Vec<u8> {
    let s = value.as_str().expect("hex string");
    (0..s.len())
        .step_by(2)
        .map(|i| u8::from_str_radix(&s[i..i + 2], 16).expect("hex"))
        .collect()
}

pub fn array<const N: usize>(value: &Value) -> [u8; N] {
    hex(value).try_into().expect("right length")
}
