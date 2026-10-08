// Shared helpers for the fixture tests (not a test file itself).
#![allow(dead_code)]

use serde_json::Value;

pub mod vault;

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
