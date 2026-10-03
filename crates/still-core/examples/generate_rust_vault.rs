//! Writes fixtures/vault-v1-rust once: a v1 vault made by the Rust session,
//! the same code path the app uses from stage 3b. The JS tests open it with
//! the old libsodium code, which proves vaults edited by the Rust app still
//! open in older builds.
//!
//! Run once with `cargo run -p still-core --example generate_rust_vault`.
//! It refuses to overwrite the fixture: never regenerate it.

use std::fs;
use std::path::Path;

use still_core::session::{SecretText, Unlocked};

const PASSWORD: &str = "Rüst-golden-v1 🦀 kettle";

struct Item {
    id: &'static str,
    label: &'static str,
    kind: &'static str,
    value: &'static str,
}

struct Lens {
    id: &'static str,
    name: &'static str,
    created_at: &'static str,
    deleted_at: Option<&'static str>,
    items: Vec<Item>,
}

fn json(text: &str) -> String {
    serde_json::to_string(text).unwrap()
}

fn main() {
    let dir = Path::new(env!("CARGO_MANIFEST_DIR")).join("../../fixtures/vault-v1-rust");
    if dir.join("vault.json").exists() {
        eprintln!(
            "{} already exists; it must never be regenerated.",
            dir.display()
        );
        std::process::exit(1);
    }

    let long = "Rust line: the quick brown fox jumps over the lazy dog. ✓\n".repeat(40);
    let long: &'static str = Box::leak(long.into_boxed_str());
    let lenses = [
        Lens {
            id: "7a1c0e3b9d5f42a68e0b1c2d3e4f5a6b",
            name: "Rust Personal",
            created_at: "2026-10-02T09:00:00.000Z",
            deleted_at: None,
            items: vec![
                Item {
                    id: "0b9e8d7c6b5a49388f7e6d5c4b3a2918",
                    label: "Email",
                    kind: "password",
                    value: "crab-Pässwörd-🔐-密码",
                },
                Item {
                    id: "1c2d3e4f5a6b4c7d8e9f0a1b2c3d4e5f",
                    label: "Spaced",
                    kind: "password",
                    value: "  two spaces both ends  ",
                },
                Item {
                    id: "2d3e4f5a6b7c4d8e9f0a1b2c3d4e5f60",
                    label: "API token",
                    kind: "key",
                    value: "sk-rust-0123456789abcdef",
                },
                Item {
                    id: "3e4f5a6b7c8d4e9fa0b1c2d3e4f5a6b7",
                    label: "Notes",
                    kind: "note",
                    value: "First line\n\tindented second line\r\nthird line \u{2028} end",
                },
                Item {
                    id: "4f5a6b7c8d9e4fa0b1c2d3e4f5a6b7c8",
                    label: "Long note",
                    kind: "note",
                    value: long,
                },
            ],
        },
        Lens {
            id: "8b2d1f4c0e6a43b79f1c2d3e4f5a6b7c",
            name: "Empty from Rust",
            created_at: "2026-10-02T09:05:00.000Z",
            deleted_at: None,
            items: vec![],
        },
        Lens {
            id: "9c3e2a5d1f7b44c8a02d3e4f5a6b7c8d",
            name: "Rust Archive",
            created_at: "2026-09-20T08:00:00.000Z",
            // Inside the 7-day window of the fixed clock the JS tests use.
            deleted_at: Some("2026-09-27T12:00:00.000Z"),
            items: vec![Item {
                id: "5a6b7c8d9e0f4a1bb2c3d4e5f6a7b8c9",
                label: "Old key",
                kind: "key",
                value: "old-rust-key ✓",
            }],
        },
    ];

    let (mut session, master_key, salt) =
        Unlocked::create(&SecretText::from(PASSWORD.to_owned())).unwrap();

    // Lens lists in the exact key order and spacing of JSON.stringify in the app.
    let mut lists = (Vec::new(), Vec::new());
    let mut expected = (Vec::new(), Vec::new());
    for lens in &lenses {
        let wrapped = session.new_lens_key(lens.id);
        let mut items = Vec::new();
        let mut plaintexts = Vec::new();
        for item in &lens.items {
            let blob = session
                .encrypt_item(lens.id, &SecretText::from(item.value.to_owned()))
                .unwrap();
            items.push(format!(
                r#"{{"id":{},"label":{},"type":{},"encryptedValue":{}}}"#,
                json(item.id),
                json(item.label),
                json(item.kind),
                json(&blob)
            ));
            plaintexts.push(format!("{}:{}", json(item.id), json(item.value)));
        }
        let deleted = lens
            .deleted_at
            .map(|at| format!(r#","deletedAt":{}"#, json(at)))
            .unwrap_or_default();
        let stored = format!(
            r#"{{"id":{},"name":{},"createdAt":{},"itemCount":{},"encryptedMasterKey":{},"items":[{}]{}}}"#,
            json(lens.id),
            json(lens.name),
            json(lens.created_at),
            lens.items.len(),
            json(&wrapped),
            items.join(","),
            deleted
        );
        let want = format!(
            r#"{}:{{"name":{},"items":{{{}}}}}"#,
            json(lens.id),
            json(lens.name),
            plaintexts.join(",")
        );
        if lens.deleted_at.is_some() {
            lists.1.push(stored);
            expected.1.push(want);
        } else {
            lists.0.push(stored);
            expected.0.push(want);
        }
    }

    let vault = serde_json::json!({
        "still-encrypted-master-key": master_key,
        "still-salt": salt,
        "still-has-pin": "false",
        "still-lenses": format!("[{}]", lists.0.join(",")),
        "still-recycle-bin": format!("[{}]", lists.1.join(",")),
    });
    let expected = format!(
        r#"{{"password":{},"lenses":{{{}}},"recycleBin":{{{}}}}}"#,
        json(PASSWORD),
        expected.0.join(","),
        expected.1.join(",")
    );
    let expected: serde_json::Value = serde_json::from_str(&expected).unwrap();

    fs::create_dir_all(&dir).unwrap();
    fs::write(
        dir.join("vault.json"),
        serde_json::to_string_pretty(&vault).unwrap() + "\n",
    )
    .unwrap();
    fs::write(
        dir.join("expected.json"),
        serde_json::to_string_pretty(&expected).unwrap() + "\n",
    )
    .unwrap();
    println!("Wrote {}", dir.display());
}
