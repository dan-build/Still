//! The committed v1 vaults must open exactly, as they do with the JS app.
//! If this fails, existing vaults would not open: fix the code, never the fixtures.

mod common;

use common::fixture;
use serde_json::Value;
use still_core::crypto::{decrypt_item, decrypt_lens_key, decrypt_master_key};
use still_core::Error;

fn check_vault(dir: &str) {
    let vault = fixture(&format!("{dir}/vault.json"));
    let expected = fixture(&format!("{dir}/expected.json"));
    let password = expected["password"].as_str().unwrap();
    let str_of = |key: &str| vault[key].as_str().unwrap();

    let app_key = decrypt_master_key(
        str_of("still-encrypted-master-key"),
        password,
        str_of("still-salt"),
    )
    .unwrap_or_else(|e| panic!("{dir}: master key should open: {e}"));

    let mut items_checked = 0;
    for (list, expected_list) in [
        ("still-lenses", "lenses"),
        ("still-recycle-bin", "recycleBin"),
    ] {
        let lenses: Value = serde_json::from_str(str_of(list)).unwrap();
        let want = &expected[expected_list];
        assert_eq!(
            lenses.as_array().unwrap().len(),
            want.as_object().unwrap().len(),
            "{dir} {list}"
        );
        for lens in lenses.as_array().unwrap() {
            let id = lens["id"].as_str().unwrap();
            let lens_key =
                decrypt_lens_key(lens["encryptedMasterKey"].as_str().unwrap(), &app_key).unwrap();
            for item in lens["items"].as_array().unwrap() {
                let plaintext =
                    decrypt_item(item["encryptedValue"].as_str().unwrap(), &lens_key).unwrap();
                assert_eq!(
                    plaintext,
                    want[id]["items"][item["id"].as_str().unwrap()]
                        .as_str()
                        .unwrap()
                );
                items_checked += 1;
            }
        }
    }
    assert!(items_checked > 0, "{dir}: no items checked");

    let wrong = decrypt_master_key(
        str_of("still-encrypted-master-key"),
        &format!("{password}x"),
        str_of("still-salt"),
    );
    assert_eq!(wrong.unwrap_err(), Error::WrongKey);
}

#[test]
fn opens_the_generated_golden_vault() {
    check_vault("vault-v1");
}

#[test]
fn opens_the_vault_exported_from_a_release_build() {
    check_vault("vault-v1-real");
}

#[test]
fn opens_the_vault_made_by_the_rust_session() {
    check_vault("vault-v1-rust");
}
