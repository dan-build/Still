//! The session opens the committed v1 vaults and keeps the backend's rules:
//! a wrong password and damaged data are told apart, a Lens whose key
//! doesn't open is reported (and its key not held), and secrets round-trip
//! exactly.

mod common;

use common::fixture;
use serde_json::Value;
use still_core::crypto::encrypt_lens_key;
use still_core::session::{SecretText, SessionError, Unlocked, WrappedLensKey};
use still_core::Key;

struct StoredLens {
    id: String,
    key: String,
    items: Vec<(String, String)>,
}

/// Every Lens in a fixture, list then bin, as the backend passes them.
fn stored_lenses(vault: &Value) -> Vec<StoredLens> {
    ["still-lenses", "still-recycle-bin"]
        .iter()
        .flat_map(|list| {
            let lenses: Value = serde_json::from_str(vault[*list].as_str().unwrap()).unwrap();
            lenses.as_array().unwrap().clone()
        })
        .map(|lens| StoredLens {
            id: lens["id"].as_str().unwrap().to_owned(),
            key: lens["encryptedMasterKey"].as_str().unwrap().to_owned(),
            items: lens["items"]
                .as_array()
                .unwrap()
                .iter()
                .map(|i| {
                    let id = i["id"].as_str().unwrap().to_owned();
                    (id, i["encryptedValue"].as_str().unwrap().to_owned())
                })
                .collect(),
        })
        .collect()
}

fn wrapped(lenses: &[StoredLens]) -> Vec<WrappedLensKey<'_>> {
    lenses
        .iter()
        .map(|l| WrappedLensKey {
            id: &l.id,
            encrypted_master_key: &l.key,
        })
        .collect()
}

fn secret(text: &str) -> SecretText {
    SecretText::from(text.to_owned())
}

fn open(dir: &str, password: &str) -> Result<(Unlocked, Vec<bool>), SessionError> {
    let vault = fixture(&format!("{dir}/vault.json"));
    let lenses = stored_lenses(&vault);
    Unlocked::open(
        vault["still-encrypted-master-key"].as_str().unwrap(),
        vault["still-salt"].as_str().unwrap(),
        &secret(password),
        &wrapped(&lenses),
    )
}

#[test]
fn opens_both_golden_vaults_and_reveals_every_secret_exactly() {
    for dir in ["vault-v1", "vault-v1-real"] {
        let vault = fixture(&format!("{dir}/vault.json"));
        let expected = fixture(&format!("{dir}/expected.json"));
        let lenses = stored_lenses(&vault);
        let (session, opened) = Unlocked::open(
            vault["still-encrypted-master-key"].as_str().unwrap(),
            vault["still-salt"].as_str().unwrap(),
            &secret(expected["password"].as_str().unwrap()),
            &wrapped(&lenses),
        )
        .unwrap_or_else(|e| panic!("{dir} should open: {e}"));

        assert_eq!(opened, vec![true; lenses.len()], "{dir}");
        let mut revealed = 0;
        for lens in &lenses {
            let want = if expected["lenses"].get(&lens.id).is_some() {
                &expected["lenses"][&lens.id]
            } else {
                &expected["recycleBin"][&lens.id]
            };
            for (item_id, blob) in &lens.items {
                let value = session.decrypt_item(&lens.id, blob).unwrap();
                assert_eq!(value.expose(), want["items"][item_id].as_str().unwrap());
                revealed += 1;
            }
        }
        assert!(revealed > 0, "{dir} has secrets to reveal");
    }
}

#[test]
fn tells_a_wrong_password_from_damaged_data() {
    assert_eq!(
        open("vault-v1-real", "throwaway-vault-20").unwrap_err(),
        SessionError::WrongPassword
    );

    // Damaged data is refused before Argon2id runs.
    let vault = fixture("vault-v1/vault.json");
    let salt = vault["still-salt"].as_str().unwrap();
    let result = Unlocked::open("AQID", salt, &secret("anything"), &[]);
    assert_eq!(result.unwrap_err(), SessionError::Corrupt);
    assert_eq!(SessionError::Corrupt.code(), "corrupt");
}

#[test]
fn reports_each_lens_entry_and_holds_only_keys_that_opened() {
    let vault = fixture("vault-v1/vault.json");
    let expected = fixture("vault-v1/expected.json");
    let lenses = stored_lenses(&vault);
    let good = &lenses[0];
    // The bin's Lens, which has an item under a different Lens key.
    let other = lenses.iter().rfind(|l| !l.items.is_empty()).unwrap();
    // A Lens key wrapped by some other app key, and damaged ones.
    let foreign = encrypt_lens_key(&Key::random(), &Key::random());
    let truncated = &good.key[..good.key.len() - 4];
    let entries = [
        WrappedLensKey {
            id: "foreign",
            encrypted_master_key: &foreign,
        },
        WrappedLensKey {
            id: &good.id,
            encrypted_master_key: &good.key,
        },
        WrappedLensKey {
            id: "damaged",
            encrypted_master_key: "not base64!",
        },
        WrappedLensKey {
            id: "truncated",
            encrypted_master_key: truncated,
        },
    ];
    let (session, opened) = Unlocked::open(
        vault["still-encrypted-master-key"].as_str().unwrap(),
        vault["still-salt"].as_str().unwrap(),
        &secret(expected["password"].as_str().unwrap()),
        &entries,
    )
    .unwrap();

    assert_eq!(opened, vec![false, true, false, false]);
    let (_, blob) = &good.items[0];
    assert!(session.decrypt_item(&good.id, blob).is_ok());
    assert_eq!(
        session.decrypt_item("foreign", blob).unwrap_err(),
        SessionError::UnknownLens
    );
    // An item blob under the wrong Lens key is damaged data, never revealed.
    let (_, other_blob) = &other.items[0];
    assert_eq!(
        session.decrypt_item(&good.id, other_blob).unwrap_err(),
        SessionError::Corrupt
    );
}

#[test]
fn a_new_vault_reopens_with_its_password_and_keeps_secrets_exact() {
    let (mut session, blob, salt) = Unlocked::create(&secret("pw-123456")).unwrap();
    let wrapped_key = session.new_lens_key("lens-a");
    let value = "  Pässwörd 🔐 with spaces\nand a line  ";
    let item = session.encrypt_item("lens-a", &secret(value)).unwrap();
    assert!(!item.contains("Pässwörd"));
    assert_eq!(
        session
            .encrypt_item("lens-a", &secret(" \n\t"))
            .unwrap_err(),
        SessionError::Failed,
        "blank values are refused, as in the app"
    );
    drop(session);

    let lens = [WrappedLensKey {
        id: "lens-a",
        encrypted_master_key: &wrapped_key,
    }];
    assert_eq!(
        Unlocked::open(&blob, &salt, &secret("pw-1234567"), &lens).unwrap_err(),
        SessionError::WrongPassword
    );
    let (reopened, opened) = Unlocked::open(&blob, &salt, &secret("pw-123456"), &lens).unwrap();
    assert_eq!(opened, vec![true]);
    assert_eq!(
        reopened.decrypt_item("lens-a", &item).unwrap().expose(),
        value
    );
}

#[test]
fn never_prints_keys_or_secrets() {
    let (mut session, _, _) = Unlocked::create(&secret("pw-123456")).unwrap();
    session.new_lens_key("lens-a");
    assert_eq!(format!("{session:?}"), "Unlocked(1 Lens keys, redacted)");
    assert_eq!(format!("{:?}", secret("hunter2")), "SecretText(redacted)");
}
