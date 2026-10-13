//! The vault backend on a vault in format v2: created, unlocked, changed and
//! saved in v2, with the same rules as v1 (tests/behaviour_v1.rs), and the
//! golden v2 vault opened with the real keys.

mod common;

use std::sync::Arc;

use common::vault::{FastKeys, Memory};
use serde_json::Value;
use still_core::session::{SecretText, Unlocked};
use still_core::v2;
use still_core::vault::backend::{Backend, Keys, Notice, Status, UnlockFailure, VaultError};

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

// ---- converting from v1 ---------------------------------------------------------

/// A v1 vault (two Lenses, one archived long ago), locked, on storage that
/// converts. Returns the storage and the v1 values as they were.
fn v1_vault() -> (Memory, std::collections::BTreeMap<String, String>) {
    let disk = Memory::default();
    let mut vault = backend::<FastKeys>(&disk);
    vault.create(&secret("pw")).unwrap();
    let work = vault.create_lens("Work").unwrap();
    vault
        .add_item(&work, "Email", "password", &secret(" exact "))
        .unwrap();
    vault.create_lens("Home").unwrap();
    vault.lock();
    disk.0.borrow_mut().creates_v2 = true;
    let before = disk.0.borrow().data.clone();
    (disk, before)
}

#[test]
fn converts_a_v1_vault_on_its_first_unlock_keeping_the_v1_file() {
    let (disk, before) = v1_vault();
    let mut vault = backend::<FastKeys>(&disk);
    vault.unlock(&secret("pw")).unwrap();
    assert!(matches!(vault.take_notice(), Some(Notice::Upgraded { .. })));
    assert_eq!(vault.take_notice(), None);

    // The v1 values are kept exactly; the vault is now v2 and holds the very same lists.
    assert_eq!(disk.0.borrow().kept_v1, vec![before.clone()]);
    assert!(disk.0.borrow().data.is_empty());
    let lists = stored_lists(&disk, "pw");
    assert_eq!(lists.lenses, before["still-lenses"]);
    assert_eq!(
        lists.bin,
        before
            .get("still-recycle-bin")
            .cloned()
            .unwrap_or_else(|| "[]".into())
    );
    let file = v2::File::parse(disk.0.borrow().v2.as_deref().unwrap()).unwrap();
    assert_eq!(file.migrated_from.as_deref(), Some("vault-v1"));

    // Everything works as before, and saves go to v2.
    let work = vault
        .view()
        .lenses
        .iter()
        .find(|l| l["name"] == "Work")
        .unwrap()
        .clone();
    let item = work["items"][0]["id"].as_str().unwrap();
    assert_eq!(
        vault
            .reveal_item(work["id"].as_str().unwrap(), item)
            .unwrap()
            .expose(),
        " exact "
    );
    vault.create_lens("After").unwrap();
    assert!(disk.0.borrow().data.is_empty());
    assert!(stored_lists(&disk, "pw").lenses.contains("After"));

    // The next unlock is a plain v2 one.
    vault.lock();
    let mut again = backend::<FastKeys>(&disk);
    again.unlock(&secret("pw")).unwrap();
    assert_eq!(again.take_notice(), None);
    assert_eq!(disk.0.borrow().kept_v1.len(), 1);
}

#[test]
fn leaves_the_vault_as_it_was_when_converting_fails_and_tries_again() {
    let (disk, before) = v1_vault();
    disk.0.borrow_mut().fail_keys.insert("convert".into());
    let mut vault = backend::<FastKeys>(&disk);
    vault.unlock(&secret("pw")).unwrap();
    assert_eq!(vault.take_notice(), Some(Notice::UpgradeFailed));
    assert_eq!(disk.0.borrow().data, before);
    assert!(disk.0.borrow().v2.is_none());
    // It still works, in v1.
    vault.create_lens("Still v1").unwrap();
    assert!(disk.0.borrow().data["still-lenses"].contains("Still v1"));

    vault.lock();
    disk.0.borrow_mut().fail_keys.clear();
    let mut retry = backend::<FastKeys>(&disk);
    retry.unlock(&secret("pw")).unwrap();
    assert!(matches!(retry.take_notice(), Some(Notice::Upgraded { .. })));
    assert!(stored_lists(&disk, "pw").lenses.contains("Still v1"));
}

#[test]
fn opens_an_old_copy_as_it_is_when_told_to() {
    let (disk, before) = v1_vault();
    let mut vault = backend::<FastKeys>(&disk);
    vault.set_convert_v1(false);
    vault.unlock(&secret("pw")).unwrap();
    assert_eq!(vault.take_notice(), None);
    assert_eq!(disk.0.borrow().data, before);
    assert!(disk.0.borrow().v2.is_none());
}

#[test]
fn saves_the_archive_purge_of_a_converting_unlock_in_v2() {
    let disk = Memory::default();
    let mut vault = backend::<FastKeys>(&disk);
    vault.create(&secret("pw")).unwrap();
    let old = vault.create_lens("Old").unwrap();
    vault = Backend::new(disk.clone(), Arc::new(|| NOW - 30 * 86_400_000));
    vault.unlock(&secret("pw")).unwrap();
    vault.forget_lens(&old).unwrap();
    vault.lock();
    let before = disk.0.borrow().data.clone();
    disk.0.borrow_mut().creates_v2 = true;

    let mut vault = backend::<FastKeys>(&disk);
    vault.unlock(&secret("pw")).unwrap();
    assert!(vault.view().bin.is_empty());
    // The kept v1 file still has it; the v2 vault has purged it.
    assert_eq!(disk.0.borrow().kept_v1, vec![before]);
    assert_eq!(stored_lists(&disk, "pw").bin, "[]");
}

#[test]
fn never_converts_lists_that_changed_since_they_were_read() {
    let (disk, _) = v1_vault();
    let mut vault = backend::<FastKeys>(&disk);
    let plan = vault.prepare_unlock().unwrap();
    let opened = plan.open::<FastKeys>(&secret("pw"));
    // Something changes the stored lists while the password step runs.
    disk.0
        .borrow_mut()
        .data
        .insert("still-recycle-bin".into(), "[ ]".into());
    vault.finish_unlock(plan, opened).unwrap();
    assert_eq!(vault.take_notice(), Some(Notice::UpgradeFailed));
    assert!(disk.0.borrow().v2.is_none());
}

// The owner's real exported vault and the golden ones, with the real keys:
// each converts to a v2 file holding its lists byte for byte, and opens.
#[test]
fn converts_the_real_and_golden_vaults_with_the_real_keys() {
    for name in ["vault-v1-real", "vault-v1", "vault-v1-rust"] {
        let vault_json = common::fixture(&format!("{name}/vault.json"));
        let expected = common::fixture(&format!("{name}/expected.json"));
        let password = expected["password"].as_str().unwrap();
        let disk = Memory::default();
        for (key, value) in vault_json.as_object().unwrap() {
            disk.0
                .borrow_mut()
                .data
                .insert(key.clone(), value.as_str().unwrap().to_owned());
        }
        disk.0.borrow_mut().creates_v2 = true;
        let before = disk.0.borrow().data.clone();
        // A fixed clock inside every Archive window, so nothing is purged.
        let mut vault: Backend<Memory, Unlocked> =
            Backend::new(disk.clone(), Arc::new(|| 1_790_553_600_000));
        vault.unlock(&secret(password)).unwrap();
        assert!(
            matches!(vault.take_notice(), Some(Notice::Upgraded { .. })),
            "{name}"
        );
        assert_eq!(disk.0.borrow().kept_v1, vec![before.clone()], "{name}");

        let file = v2::File::parse(disk.0.borrow().v2.as_deref().unwrap()).unwrap();
        let (_, body) = Unlocked::open_v2(&file, &secret(password)).unwrap();
        assert_eq!(body.lenses, before["still-lenses"], "{name}");
        assert_eq!(body.bin, before["still-recycle-bin"], "{name}");

        let view = vault.view();
        for (list, want) in [
            (&view.lenses, &expected["lenses"]),
            (&view.bin, &expected["recycleBin"]),
        ] {
            for lens in list {
                let id = lens["id"].as_str().unwrap();
                for item in lens["items"].as_array().unwrap() {
                    let item_id = item["id"].as_str().unwrap();
                    assert_eq!(
                        vault.reveal_item(id, item_id).unwrap().expose(),
                        want[id]["items"][item_id],
                        "{name}"
                    );
                }
            }
        }
    }
}

// ---- saves only ever go onto this vault's own file ---------------------------------

/// A v2 vault with one Lens, unlocked, on `disk`.
fn unlocked_v2(disk: &Memory, password: &str) -> Backend<Memory, FastKeys> {
    let mut vault = backend::<FastKeys>(disk);
    vault.create(&secret(password)).unwrap();
    vault.create_lens("Mine").unwrap();
    vault
}

#[test]
fn never_seals_onto_another_vaults_file() {
    let disk = v2_disk();
    let mut vault = unlocked_v2(&disk, "pw");
    // Another vault's file is put in place (a backup, a synced copy).
    let other = v2_disk();
    unlocked_v2(&other, "other");
    let foreign = other.0.borrow().v2.clone();
    disk.0.borrow_mut().v2 = foreign.clone();

    assert_eq!(
        vault.create_lens("Lost").err(),
        Some(VaultError::WriteFailed)
    );
    assert_eq!(disk.0.borrow().v2, foreign);
    assert_eq!(names(&vault.view().lenses), ["Mine"]);

    // With the file gone, a save fails too, and nothing changes.
    disk.0.borrow_mut().v2 = None;
    assert_eq!(
        vault.create_lens("Lost").err(),
        Some(VaultError::WriteFailed)
    );
    assert_eq!(names(&vault.view().lenses), ["Mine"]);
    assert!(disk.0.borrow().data.is_empty());
}

#[test]
fn creates_after_a_set_aside_and_keeps_the_copies_when_it_converts() {
    // Orphaned v1 data, set aside: the file now holds only the copies.
    let disk = Memory::default();
    disk.0
        .borrow_mut()
        .data
        .insert("still-lenses".into(), "[{\"id\":\"o\"}]".into());
    disk.0.borrow_mut().creates_v2 = true;
    let mut vault = backend::<FastKeys>(&disk);
    let prefix = vault.set_aside().unwrap();
    let copies = disk.0.borrow().data.clone();
    assert!(copies.keys().all(|k| k.starts_with(&prefix)));

    // Create works (in v1, next to the copies), and the first unlock converts,
    // keeping the whole v1 file, copies included.
    vault.create(&secret("pw")).unwrap();
    vault.create_lens("New").unwrap();
    vault.lock();
    let before = disk.0.borrow().data.clone();
    let mut again = backend::<FastKeys>(&disk);
    again.unlock(&secret("pw")).unwrap();
    assert!(matches!(again.take_notice(), Some(Notice::Upgraded { .. })));
    let kept = disk.0.borrow().kept_v1.clone();
    assert_eq!(kept, vec![before]);
    assert!(copies.iter().all(|(k, v)| kept[0].get(k) == Some(v)));
    assert_eq!(names(&again.view().lenses), ["New"]);
}

#[test]
fn writes_back_a_list_a_change_leaves_alone_exactly_as_stored() {
    // A readable Lens stored without an items field: in memory it gets one,
    // but an Archive-only change (the purge here) must not rewrite Lenses.
    let disk = v2_disk();
    let mut vault = unlocked_v2(&disk, "pw");
    let old = vault.create_lens("Old").unwrap();
    vault.forget_lens(&old).unwrap();
    vault.lock();
    let file = v2::File::parse(disk.0.borrow().v2.as_deref().unwrap()).unwrap();
    let (keys, body) = FastKeys::open_v2(&file, &secret("pw")).unwrap();
    let lenses: Value = serde_json::from_str(&body.lenses).unwrap();
    let mut lens = lenses[0].clone();
    lens.as_object_mut().unwrap().remove("items");
    let lenses_text = serde_json::to_string(&vec![lens]).unwrap();
    let bin: Value = serde_json::from_str(&body.bin).unwrap();
    let mut archived = bin[0].clone();
    archived["deletedAt"] = serde_json::json!("2020-01-01T00:00:00.000Z");
    let edited = v2::Body {
        lenses: lenses_text.clone(),
        bin: serde_json::to_string(&vec![archived]).unwrap(),
    };
    disk.0.borrow_mut().v2 = Some(keys.seal_v2(&file, &edited).to_json());

    let mut vault = backend::<FastKeys>(&disk);
    vault.unlock(&secret("pw")).unwrap();
    let after = stored_lists(&disk, "pw");
    assert_eq!(after.bin, "[]");
    assert_eq!(after.lenses, lenses_text);
}

#[test]
fn keeps_an_unreadable_lens_byte_for_byte_across_saves() {
    let disk = v2_disk();
    let mut vault = unlocked_v2(&disk, "pw");
    vault.lock();
    let file = v2::File::parse(disk.0.borrow().v2.as_deref().unwrap()).unwrap();
    let (keys, body) = FastKeys::open_v2(&file, &secret("pw")).unwrap();
    let broken = r#"{"id":"broken","name":"Broken","encryptedMasterKey":"AQAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAkJCQkJCQkJCQkJCQkJCQkJCQkJCQkJCQkJCQkJCQkJBwcHBwcHBwcHBwcHBwcHBw==","extra":[1,{"x":null}]}"#;
    let lenses = body.lenses.replacen('[', &format!("[{broken},"), 1);
    let edited = v2::Body {
        lenses,
        bin: body.bin.clone(),
    };
    disk.0.borrow_mut().v2 = Some(keys.seal_v2(&file, &edited).to_json());

    let mut vault = backend::<FastKeys>(&disk);
    vault.unlock(&secret("pw")).unwrap();
    assert_eq!(vault.view().unreadable, 1);
    vault.create_lens("Another").unwrap();
    assert!(stored_lists(&disk, "pw").lenses.contains(broken));
}

#[test]
fn refuses_damaged_or_null_lists_inside_a_good_body() {
    for (lenses, want) in [
        ("{oops", UnlockFailure::UnreadableData),
        ("[1.0]", UnlockFailure::UnreadableData),
        ("[null]", UnlockFailure::Failed),
    ] {
        let disk = v2_disk();
        unlocked_v2(&disk, "pw").lock();
        let file = v2::File::parse(disk.0.borrow().v2.as_deref().unwrap()).unwrap();
        let (keys, _) = FastKeys::open_v2(&file, &secret("pw")).unwrap();
        let body = v2::Body {
            lenses: lenses.into(),
            bin: "[]".into(),
        };
        let sealed = keys.seal_v2(&file, &body).to_json();
        disk.0.borrow_mut().v2 = Some(sealed.clone());
        disk.0.borrow_mut().writes.clear();
        assert_eq!(
            backend::<FastKeys>(&disk).unlock(&secret("pw")),
            Err(want),
            "{lenses}"
        );
        assert_eq!(disk.0.borrow().v2.as_deref(), Some(sealed.as_str()));
        assert!(disk.0.borrow().writes.is_empty());
    }
}

#[test]
fn never_offers_to_create_over_an_unreadable_file() {
    let disk = v2_disk();
    disk.0.borrow_mut().unreadable = true;
    let mut vault = backend::<FastKeys>(&disk);
    assert_eq!(vault.status(), Status::Unreadable);
    assert_eq!(vault.create(&secret("pw")), Err(VaultError::VaultExists));
    assert!(disk.0.borrow().v2.is_none() && disk.0.borrow().data.is_empty());
}
