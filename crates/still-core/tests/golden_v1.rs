//! The committed v1 vaults must open exactly, as they did with the JS app,
//! and any changed byte in them must be caught. If this fails, existing
//! vaults would not open: fix the code, never the fixtures.

mod common;

use common::fixture;
use serde_json::Value;
use still_core::crypto::{decrypt_item, decrypt_lens_key, decrypt_master_key};
use still_core::format::FormatError;
use still_core::sodium::{from_base64, to_base64};
use still_core::Error;

/// The blob with one byte flipped.
fn flipped(blob: &str, at: usize) -> String {
    let mut bytes = from_base64(blob).unwrap();
    bytes[at] ^= 0x01;
    to_base64(&bytes)
}

/// The fixture itself is whole: the five stored values, the PIN flag as the
/// app always writes it, and every Lens's items as listed in expected.json.
fn check_shape(dir: &str, vault: &Value, expected: &Value) {
    let mut keys: Vec<&str> = vault
        .as_object()
        .unwrap()
        .keys()
        .map(String::as_str)
        .collect();
    keys.sort_unstable();
    assert_eq!(
        keys,
        [
            "still-encrypted-master-key",
            "still-has-pin",
            "still-lenses",
            "still-recycle-bin",
            "still-salt"
        ],
        "{dir}"
    );
    assert_eq!(vault["still-has-pin"], "false", "{dir}");
    for (list, expected_list) in [
        ("still-lenses", "lenses"),
        ("still-recycle-bin", "recycleBin"),
    ] {
        let lenses: Value = serde_json::from_str(vault[list].as_str().unwrap()).unwrap();
        for lens in lenses.as_array().unwrap() {
            let items = lens["items"].as_array().unwrap();
            assert_eq!(lens["itemCount"], items.len(), "{dir} itemCount");
            let mut ids: Vec<&str> = items.iter().map(|i| i["id"].as_str().unwrap()).collect();
            ids.sort_unstable();
            let want = &expected[expected_list][lens["id"].as_str().unwrap()]["items"];
            let mut want_ids: Vec<&str> = want
                .as_object()
                .unwrap()
                .keys()
                .map(String::as_str)
                .collect();
            want_ids.sort_unstable();
            assert_eq!(ids, want_ids, "{dir} items");
        }
    }
}

fn check_vault(dir: &str) {
    let vault = fixture(&format!("{dir}/vault.json"));
    let expected = fixture(&format!("{dir}/expected.json"));
    let password = expected["password"].as_str().unwrap();
    let str_of = |key: &str| vault[key].as_str().unwrap();
    check_shape(dir, &vault, &expected);

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
            let wrapped = lens["encryptedMasterKey"].as_str().unwrap();
            let lens_key = decrypt_lens_key(wrapped, &app_key).unwrap();
            // A changed nonce, key or tag byte is caught.
            for at in [1, 24, 25, 72] {
                assert_eq!(
                    decrypt_lens_key(&flipped(wrapped, at), &app_key).err(),
                    Some(Error::WrongKey),
                    "{dir} Lens key byte {at}"
                );
            }
            for item in lens["items"].as_array().unwrap() {
                let blob = item["encryptedValue"].as_str().unwrap();
                let plaintext = decrypt_item(blob, &lens_key).unwrap();
                // Version, subkey id (4 bytes), nonce (24), ciphertext, tag (16).
                let len = from_base64(blob).unwrap().len();
                assert_eq!(len, 45 + plaintext.len(), "{dir} item length");
                for at in [1, 4, 5, 28, 29, len - 17, len - 1] {
                    assert_eq!(
                        decrypt_item(&flipped(blob, at), &lens_key).err(),
                        Some(Error::WrongKey),
                        "{dir} item byte {at}"
                    );
                }
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

    // A changed tag byte in the master key is caught (one more Argon2id run).
    let master = str_of("still-encrypted-master-key");
    let tampered = decrypt_master_key(&flipped(master, 72), password, str_of("still-salt"));
    assert_eq!(
        tampered.err(),
        Some(Error::WrongKey),
        "{dir} master key tag"
    );
    // An unknown version is damaged data, found before any Argon2id run.
    let mut bytes = from_base64(master).unwrap();
    bytes[0] = 2;
    let version_2 = decrypt_master_key(&to_base64(&bytes), password, str_of("still-salt"));
    assert_eq!(
        version_2.err(),
        Some(Error::Corrupt(FormatError::UnsupportedVersion(2))),
        "{dir}"
    );
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
