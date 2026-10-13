//! The vault backend on a vault in format v2: created, unlocked, changed and
//! saved in v2, with the same rules as v1 (tests/behaviour_v1.rs), and the
//! golden v2 vault opened with the real keys.

mod common;

use std::sync::Arc;

use common::vault::{FastKeys, Memory};
use serde_json::Value;
use still_core::session::{SecretText, Unlocked};
use still_core::v2;
use still_core::vault::backend::{Backend, Keys, Status, UnlockFailure, VaultError};

const NOW: i64 = 1_791_460_800_000; // 2026-10-08T12:00:00.000Z

fn secret(text: &str) -> SecretText {
    SecretText::from(text.to_owned())
}

fn backend<K: Keys>(disk: &Memory) -> Backend<Memory, K> {
    Backend::new(disk.clone(), Arc::new(|| NOW))
}

/// Storage that creates new vaults in v2.
fn v2_disk() -> Memory {
    let disk = Memory::default();
    disk.0.borrow_mut().creates_v2 = true;
    disk
}

fn names(list: &[Value]) -> Vec<String> {
    list.iter()
        .map(|l| l["name"].as_str().unwrap().to_owned())
        .collect()
}

/// The stored body's lists, opened with the vault's password (fast keys).
fn stored_lists(disk: &Memory, password: &str) -> v2::Body {
    let file = v2::File::parse(disk.0.borrow().v2.as_deref().unwrap()).unwrap();
    FastKeys::open_v2(&file, &secret(password)).unwrap().1
}

#[test]
fn creates_and_saves_a_new_vault_in_v2_only() {
    let disk = v2_disk();
    let mut vault = backend::<FastKeys>(&disk);
    vault.create(&secret("pw")).unwrap();
    let work = vault.create_lens("Work").unwrap();
    vault
        .add_item(&work, "Email", "password", &secret(" exact "))
        .unwrap();

    // Nothing in v1, and nothing readable in the v2 file.
    assert!(disk.0.borrow().data.is_empty());
    let text = disk.0.borrow().v2.clone().unwrap();
    assert!(!text.contains("Work") && !text.contains("Email") && !text.contains("lenses"));
    assert!(stored_lists(&disk, "pw")
        .lenses
        .contains("\"name\":\"Work\""));

    vault.lock();
    assert_eq!(vault.status(), Status::Locked);
    let mut reopened = backend::<FastKeys>(&disk);
    assert_eq!(reopened.status(), Status::Locked);
    reopened.unlock(&secret("pw")).unwrap();
    let item = reopened.view().lenses[0]["items"][0]["id"]
        .as_str()
        .unwrap()
        .to_owned();
    assert_eq!(
        reopened.reveal_item(&work, &item).unwrap().expose(),
        " exact "
    );
}

// The same changes on a v1 vault and a v2 vault leave the same lists (the
// rules don't depend on the format); only how they are stored differs.
#[test]
fn keeps_the_same_rules_as_v1() {
    let run = |disk: &Memory| {
        let mut vault = backend::<FastKeys>(disk);
        vault.create(&secret("pw")).unwrap();
        let a = vault.create_lens("  A  ").unwrap();
        let b = vault.create_lens("B").unwrap();
        vault.add_item(&a, "One", "note", &secret("1\n")).unwrap();
        vault.add_item(&a, "Two", "key", &secret("2")).unwrap();
        let two = vault.view().lenses[1]["items"][1]["id"]
            .as_str()
            .unwrap()
            .to_owned();
        vault
            .update_item(&a, &two, " Two (edited) ", "password", None)
            .unwrap();
        vault.rename_lens(&b, "Renamed").unwrap();
        vault.forget_lens(&b).unwrap();
        assert_eq!(vault.rename_lens(&b, "X"), Err(VaultError::UnknownLens));
        vault.restore_lens(&b).unwrap();
        vault.forget_lens(&a).unwrap();
        vault.lock();
        let mut vault = backend::<FastKeys>(disk);
        vault.unlock(&secret("pw")).unwrap();
        let view = vault.view();
        (
            names(&view.lenses),
            names(&view.bin),
            view.to_json()["bin"][0]["items"].clone(),
        )
    };
    let (v1, v2) = (Memory::default(), v2_disk());
    let (from_v1, from_v2) = (run(&v1), run(&v2));
    // Ids are random, so compare everything but them.
    let strip = |items: &Value| -> Vec<(Value, Value)> {
        items
            .as_array()
            .unwrap()
            .iter()
            .map(|i| (i["label"].clone(), i["type"].clone()))
            .collect()
    };
    assert_eq!((&from_v1.0, &from_v1.1), (&from_v2.0, &from_v2.1));
    assert_eq!(strip(&from_v1.2), strip(&from_v2.2));
    assert_eq!(from_v2.0, ["Renamed"]);
    assert_eq!(from_v2.1, ["A"]);
}

#[test]
fn a_failed_save_changes_nothing() {
    let disk = v2_disk();
    let mut vault = backend::<FastKeys>(&disk);
    vault.create(&secret("pw")).unwrap();
    vault.create_lens("Kept").unwrap();
    let before = disk.0.borrow().v2.clone();
    disk.0.borrow_mut().fail_keys.insert("v2".into());
    assert_eq!(
        vault.create_lens("Lost").err(),
        Some(VaultError::WriteFailed)
    );
    assert_eq!(names(&vault.view().lenses), ["Kept"]);
    assert_eq!(disk.0.borrow().v2, before);
}

#[test]
fn a_change_that_changes_nothing_writes_nothing() {
    let disk = v2_disk();
    let mut vault = backend::<FastKeys>(&disk);
    vault.create(&secret("pw")).unwrap();
    disk.0.borrow_mut().writes.clear();
    vault.forget_lens("no-such-lens").unwrap();
    vault.restore_lens("no-such-lens").unwrap();
    assert!(disk.0.borrow().writes.is_empty());
}

#[test]
fn reports_a_changed_body_as_damaged_and_a_changed_key_as_a_wrong_password() {
    let disk = v2_disk();
    let mut vault = backend::<FastKeys>(&disk);
    vault.create(&secret("pw")).unwrap();
    vault.create_lens("A").unwrap();
    vault.lock();
    let good = v2::File::parse(disk.0.borrow().v2.as_deref().unwrap()).unwrap();

    let mut body = good.clone();
    let middle = body.body.len() / 2;
    body.body[middle] ^= 1;
    disk.0.borrow_mut().v2 = Some(body.to_json());
    assert_eq!(
        backend::<FastKeys>(&disk).unlock(&secret("pw")),
        Err(UnlockFailure::UnreadableData)
    );

    let mut key = good.clone();
    key.master_key[40] ^= 1;
    disk.0.borrow_mut().v2 = Some(key.to_json());
    assert_eq!(
        backend::<FastKeys>(&disk).unlock(&secret("pw")),
        Err(UnlockFailure::WrongPassword)
    );

    // Nothing was written by either attempt, and the real file still opens.
    disk.0.borrow_mut().v2 = Some(good.to_json());
    backend::<FastKeys>(&disk).unlock(&secret("pw")).unwrap();
}

#[test]
fn lets_a_lock_during_the_password_step_win() {
    let disk = v2_disk();
    let mut vault = backend::<FastKeys>(&disk);
    vault.create(&secret("pw")).unwrap();
    vault.lock();
    let plan = vault.prepare_unlock().unwrap();
    let opened = plan.open::<FastKeys>(&secret("pw"));
    vault.lock();
    assert_eq!(
        vault.finish_unlock(plan, opened),
        Err(UnlockFailure::Failed)
    );
    assert_eq!(vault.status(), Status::Locked);
}

#[test]
fn refuses_to_create_over_a_v2_vault() {
    let disk = v2_disk();
    backend::<FastKeys>(&disk).create(&secret("first")).unwrap();
    let before = disk.0.borrow().v2.clone();
    assert_eq!(
        backend::<FastKeys>(&disk).create(&secret("second")),
        Err(VaultError::VaultExists)
    );
    assert_eq!(disk.0.borrow().v2, before);
}

// With the real keys: Argon2id with the recorded settings, twice to create.
#[test]
fn creates_and_opens_a_v2_vault_with_the_real_keys() {
    let disk = v2_disk();
    let mut vault = backend::<Unlocked>(&disk);
    vault.create(&secret("real-pw-v2")).unwrap();
    let lens = vault.create_lens("Real").unwrap();
    vault
        .add_item(&lens, "Key", "key", &secret("sk-real"))
        .unwrap();
    vault.lock();
    let mut reopened = backend::<Unlocked>(&disk);
    reopened.unlock(&secret("real-pw-v2")).unwrap();
    let item = reopened.view().lenses[0]["items"][0]["id"]
        .as_str()
        .unwrap()
        .to_owned();
    assert_eq!(
        reopened.reveal_item(&lens, &item).unwrap().expose(),
        "sk-real"
    );
}

#[test]
fn opens_the_golden_v2_vault_through_the_backend() {
    let text = std::fs::read_to_string(format!(
        "{}/../../fixtures/vault-v2/vault.json",
        env!("CARGO_MANIFEST_DIR")
    ))
    .unwrap();
    let expected = common::fixture("vault-v2/expected.json");
    let disk = Memory::default();
    disk.0.borrow_mut().v2 = Some(text.clone());
    // A fixed clock inside the Archive window, so nothing is purged.
    let mut vault: Backend<Memory, Unlocked> =
        Backend::new(disk.clone(), Arc::new(|| 1_790_553_600_000));
    vault
        .unlock(&secret(expected["password"].as_str().unwrap()))
        .unwrap();
    let view = vault.view();
    for (list, want) in [
        (&view.lenses, &expected["lenses"]),
        (&view.bin, &expected["recycleBin"]),
    ] {
        assert_eq!(list.len(), want.as_object().unwrap().len());
        for lens in list {
            let id = lens["id"].as_str().unwrap();
            assert_eq!(lens["name"], want[id]["name"]);
            for item in lens["items"].as_array().unwrap() {
                let item_id = item["id"].as_str().unwrap();
                assert_eq!(
                    vault.reveal_item(id, item_id).unwrap().expose(),
                    want[id]["items"][item_id]
                );
            }
        }
    }
    // Unlocking wrote nothing.
    assert_eq!(disk.0.borrow().v2.as_deref(), Some(text.as_str()));
    assert!(disk.0.borrow().writes.is_empty());
}
