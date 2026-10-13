//! Writes fixtures/vault-v2 once: the golden v1 vault (fixtures/vault-v1)
//! in format v2, with a fixed salt and fixed nonces so every byte is pinned,
//! plus vectors for the parts of the format. Same password, same app key,
//! same lists, byte for byte.
//!
//! Run once with `cargo run -p still-core --example generate_v2_vault`.
//! It refuses to overwrite the fixture: never regenerate it.

use std::fs;
use std::path::Path;

use serde_json::{json, Value};
use still_core::crypto::{decrypt_master_key, Key};
use still_core::v2::{self, Body, File, Kdf};

const SALT: [u8; 16] = [0x5a; 16];
const MASTER_KEY_NONCE: [u8; 24] = [0x6b; 24];
const BODY_NONCE: [u8; 24] = [0x7c; 24];

fn hex(bytes: &[u8]) -> String {
    bytes.iter().map(|b| format!("{b:02x}")).collect()
}

fn main() {
    let root = Path::new(env!("CARGO_MANIFEST_DIR")).join("../../fixtures");
    let dir = root.join("vault-v2");
    if dir.join("vault.json").exists() {
        eprintln!(
            "{} already exists; it must never be regenerated.",
            dir.display()
        );
        std::process::exit(1);
    }
    let read = |name: &str| -> Value {
        serde_json::from_str(&fs::read_to_string(root.join("vault-v1").join(name)).unwrap())
            .unwrap()
    };
    let v1 = read("vault.json");
    let expected = read("expected.json");
    let password = expected["password"].as_str().unwrap();
    let field = |key: &str| v1[key].as_str().unwrap();

    let app_key = decrypt_master_key(
        field("still-encrypted-master-key"),
        password,
        field("still-salt"),
    )
    .expect("the golden v1 vault opens");
    let kdf = Kdf::sensitive(SALT);
    let password_key = kdf.password_key(password).unwrap();
    let body = Body {
        lenses: field("still-lenses").to_owned(),
        bin: field("still-recycle-bin").to_owned(),
    };
    let master_key = v2::wrap_master_key(&app_key, &password_key, &kdf, MASTER_KEY_NONCE);
    let file = File {
        body: v2::seal_body(&body, &kdf, &master_key, &app_key, BODY_NONCE),
        kdf: kdf.clone(),
        master_key,
        migrated_from: Some("vault-v1".into()),
    };
    // It must open before it is written.
    let reread = File::parse(&file.to_json()).unwrap();
    let opened = reread
        .open_body(&reread.open_master_key(&password_key).unwrap())
        .unwrap();
    assert_eq!(
        (opened.lenses.as_str(), opened.bin.as_str()),
        (field("still-lenses"), field("still-recycle-bin"))
    );

    // Vectors from fixed keys, so any implementation can check each part.
    let fixed_app = Key::from_bytes([0x11; 32]);
    let fixed_password_key = Key::from_bytes([0x22; 32]);
    let small = Body {
        lenses: "[]".into(),
        bin: "[]".into(),
    };
    let fixed_master = v2::wrap_master_key(&fixed_app, &fixed_password_key, &kdf, MASTER_KEY_NONCE);
    let vectors = json!({
        "comment": "Vault format v2 vectors (docs/vault-format-v2.md). Raw bytes in hex. Generated once by crates/still-core/examples/generate_v2_vault.rs. Do not edit.",
        "kdf": { "opsLimit": kdf.ops_limit, "memLimit": kdf.mem_limit, "salt": hex(&SALT), "block": hex(&kdf.block()) },
        "appKey": hex(&[0x11; 32]),
        "passwordKey": hex(&[0x22; 32]),
        "bodyKey": hex(v2::body_key(&fixed_app).expose()),
        "masterKeyNonce": hex(&MASTER_KEY_NONCE),
        "masterKey": hex(&fixed_master),
        "bodyNonce": hex(&BODY_NONCE),
        "body": { "lenses": "[]", "bin": "[]", "framed": hex(&small.frame()), "sealed": hex(&v2::seal_body(&small, &kdf, &fixed_master, &fixed_app, BODY_NONCE)) },
        "goldenPasswordKey": hex(password_key.expose()),
    });

    fs::create_dir_all(&dir).unwrap();
    fs::write(dir.join("vault.json"), file.to_json()).unwrap();
    fs::copy(
        root.join("vault-v1/expected.json"),
        dir.join("expected.json"),
    )
    .unwrap();
    let mut text = serde_json::to_string_pretty(&vectors).unwrap();
    text.push('\n');
    fs::write(dir.join("vectors.json"), text).unwrap();
    println!("Wrote {}", dir.display());
}
