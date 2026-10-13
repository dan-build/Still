//! The committed v2 vault (fixtures/vault-v2) must open exactly, and every
//! part of the format must reproduce its vectors. It holds the golden v1
//! vault's contents, so it must open to the very same lists and secrets.
//! If this fails, fix the code, never the fixture.

mod common;

use common::{fixture, hex};
use still_core::crypto::{decrypt_item, decrypt_lens_key, Key};
use still_core::v2::{self, Body, File, Kdf};
use still_core::Error;

fn key(value: &serde_json::Value) -> Key {
    Key::from_bytes(common::array(value))
}

#[test]
fn opens_the_golden_v2_vault_to_the_golden_v1_contents() {
    let text = std::fs::read_to_string(format!(
        "{}/../../fixtures/vault-v2/vault.json",
        env!("CARGO_MANIFEST_DIR")
    ))
    .unwrap();
    let file = File::parse(&text).unwrap();
    // v2 writes it byte for byte the same.
    assert_eq!(file.to_json(), text);
    assert_eq!(file.migrated_from.as_deref(), Some("vault-v1"));

    let expected = fixture("vault-v2/expected.json");
    let password = expected["password"].as_str().unwrap();
    let password_key = file.kdf.password_key(password).unwrap();
    let app_key = file.open_master_key(&password_key).unwrap();
    let body = file.open_body(&app_key).unwrap();

    let v1 = fixture("vault-v1/vault.json");
    assert_eq!(body.lenses, v1["still-lenses"].as_str().unwrap());
    assert_eq!(body.bin, v1["still-recycle-bin"].as_str().unwrap());

    let mut revealed = 0;
    for (list, want) in [
        (&body.lenses, &expected["lenses"]),
        (&body.bin, &expected["recycleBin"]),
    ] {
        let lenses: serde_json::Value = serde_json::from_str(list).unwrap();
        for lens in lenses.as_array().unwrap() {
            let lens_key =
                decrypt_lens_key(lens["encryptedMasterKey"].as_str().unwrap(), &app_key).unwrap();
            for item in lens["items"].as_array().unwrap() {
                let value =
                    decrypt_item(item["encryptedValue"].as_str().unwrap(), &lens_key).unwrap();
                let id = lens["id"].as_str().unwrap();
                assert_eq!(
                    value,
                    want[id]["items"][item["id"].as_str().unwrap()]
                        .as_str()
                        .unwrap()
                );
                revealed += 1;
            }
        }
    }
    assert!(revealed > 0);

    // Sealing the same lists with the same nonce gives the committed body,
    // so the framing of real lists (with all their escapes) is pinned too.
    let vectors = fixture("vault-v2/vectors.json");
    let resealed = v2::seal_body_with_nonce(
        &body,
        &file.kdf,
        &file.master_key,
        &app_key,
        common::array(&vectors["bodyNonce"]),
    );
    assert_eq!(resealed, file.body);

    // A wrong password is a wrong key; it never opens the body.
    let wrong = file.kdf.password_key(&format!("{password}x")).unwrap();
    assert_eq!(file.open_master_key(&wrong).err(), Some(Error::WrongKey));
}

#[test]
fn reproduces_every_vector() {
    let vectors = fixture("vault-v2/vectors.json");
    let kdf = Kdf::sensitive(common::array(&vectors["kdf"]["salt"]));
    assert_eq!(vectors["kdf"]["opsLimit"], kdf.ops_limit);
    assert_eq!(vectors["kdf"]["memLimit"], kdf.mem_limit);
    assert_eq!(kdf.block().to_vec(), hex(&vectors["kdf"]["block"]));

    let app_key = key(&vectors["appKey"]);
    let password_key = key(&vectors["passwordKey"]);
    assert_eq!(
        v2::body_key(&app_key).expose().to_vec(),
        hex(&vectors["bodyKey"])
    );

    let master_key = v2::wrap_master_key_with_nonce(
        &app_key,
        &password_key,
        &kdf,
        common::array(&vectors["masterKeyNonce"]),
    );
    assert_eq!(master_key.to_vec(), hex(&vectors["masterKey"]));

    let body = Body {
        lenses: vectors["body"]["lenses"].as_str().unwrap().into(),
        bin: vectors["body"]["bin"].as_str().unwrap().into(),
    };
    assert_eq!(body.frame(), hex(&vectors["body"]["framed"]));
    let sealed = v2::seal_body_with_nonce(
        &body,
        &kdf,
        &master_key,
        &app_key,
        common::array(&vectors["bodyNonce"]),
    );
    assert_eq!(sealed, hex(&vectors["body"]["sealed"]));

    // The golden vault's password key, from the recorded SENSITIVE settings.
    let golden = fixture("vault-v2/expected.json");
    let derived = kdf
        .password_key(golden["password"].as_str().unwrap())
        .unwrap();
    assert_eq!(
        derived.expose().to_vec(),
        hex(&vectors["goldenPasswordKey"])
    );
}
