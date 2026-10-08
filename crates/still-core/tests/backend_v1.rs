//! The vault backend with real stored vaults and the real keys, and what the
//! behaviour fixture can't show: the password step running apart from the
//! backend (as the app runs it, outside its lock), and set-aside collisions.

mod common;

use std::collections::BTreeMap;
use std::sync::Arc;

use common::vault::{FastKeys, Memory};
use serde_json::Value;
use still_core::session::{SecretText, Unlocked};
use still_core::vault::backend::{Backend, Keys, Status, UnlockFailure, VaultError};

const NOW: i64 = 1_790_553_600_000; // 2026-09-28T00:00:00.000Z, inside every golden vault's Archive window

fn secret(text: &str) -> SecretText {
    SecretText::from(text.to_owned())
}

fn backend<K: Keys>(disk: &Memory) -> Backend<Memory, K> {
    Backend::new(disk.clone(), Arc::new(|| NOW))
}

fn golden(name: &str) -> (Memory, Value) {
    let vault = common::fixture(&format!("{name}/vault.json"));
    let disk = Memory::default();
    for (key, value) in vault.as_object().unwrap() {
        disk.0
            .borrow_mut()
            .data
            .insert(key.clone(), value.as_str().unwrap().to_owned());
    }
    (disk, common::fixture(&format!("{name}/expected.json")))
}

#[test]
fn opens_every_golden_vault_and_reveals_every_secret_exactly() {
    for name in ["vault-v1", "vault-v1-real", "vault-v1-rust"] {
        let (disk, expected) = golden(name);
        let before = disk.0.borrow().data.clone();
        let mut vault = backend::<Unlocked>(&disk);
        vault
            .unlock(&secret(expected["password"].as_str().unwrap()))
            .unwrap();

        let view = vault.view();
        for (list, want) in [
            (&view.lenses, &expected["lenses"]),
            (&view.bin, &expected["recycleBin"]),
        ] {
            let mut ids: Vec<&str> = list.iter().map(|l| l["id"].as_str().unwrap()).collect();
            ids.sort_unstable();
            let mut want_ids: Vec<&str> = want
                .as_object()
                .unwrap()
                .keys()
                .map(String::as_str)
                .collect();
            want_ids.sort_unstable();
            assert_eq!(ids, want_ids, "{name}");
            for lens in list {
                let id = lens["id"].as_str().unwrap();
                assert_eq!(lens["name"], want[id]["name"], "{name}");
                for item in lens["items"].as_array().unwrap() {
                    let item_id = item["id"].as_str().unwrap();
                    let value = vault.reveal_item(id, item_id).unwrap();
                    assert_eq!(
                        value.expose(),
                        want[id]["items"][item_id],
                        "{name} {item_id}"
                    );
                }
            }
        }
        assert_eq!(view.unreadable, 0);
        // Unlocking wrote nothing.
        assert!(disk.0.borrow().writes.is_empty(), "{name}");
        assert_eq!(disk.0.borrow().data, before, "{name}");
    }
}

#[test]
fn reports_a_wrong_password_on_a_real_vault() {
    let (disk, _) = golden("vault-v1-real");
    let mut vault = backend::<Unlocked>(&disk);
    assert_eq!(
        vault.unlock(&secret("throwaway-vault-20")),
        Err(UnlockFailure::WrongPassword)
    );
    assert_eq!(vault.status(), Status::Locked);
}

#[test]
fn never_shows_keys_or_encrypted_values_in_the_view() {
    let (disk, expected) = golden("vault-v1-real");
    let mut vault = backend::<Unlocked>(&disk);
    vault
        .unlock(&secret(expected["password"].as_str().unwrap()))
        .unwrap();
    let view = vault.view().to_json().to_string();
    assert!(!view.contains("encryptedMasterKey") && !view.contains("encryptedValue"));
    // Nor any stored blob: the master key, the salt, wrapped Lens keys, values.
    let stored: Vec<String> = disk.0.borrow().data.values().cloned().collect();
    let blobs = stored.iter().flat_map(|raw| {
        let lists: Vec<Value> = serde_json::from_str(raw).unwrap_or_default();
        let mut found: Vec<String> = lists
            .iter()
            .flat_map(|lens| {
                let items = lens["items"].as_array().cloned().unwrap_or_default();
                std::iter::once(lens["encryptedMasterKey"].clone())
                    .chain(items.into_iter().map(|i| i["encryptedValue"].clone()))
            })
            .filter_map(|v| v.as_str().map(str::to_owned))
            .collect();
        if lists.is_empty() && raw.len() >= 16 {
            found.push(raw.clone());
        }
        found
    });
    let mut checked = 0;
    for blob in blobs {
        assert!(!view.contains(blob.as_str()));
        checked += 1;
    }
    assert!(checked >= 5, "{checked} blobs checked");
}

/// A vault with one Lens and one secret, locked.
fn small_vault() -> (Memory, String, String) {
    let disk = Memory::default();
    let mut vault = backend::<FastKeys>(&disk);
    vault.create(&secret("pw")).unwrap();
    let lens = vault.create_lens("A").unwrap();
    vault
        .add_item(&lens, "L", "password", &secret("v"))
        .unwrap();
    let item = vault.view().lenses[0]["items"][0]["id"]
        .as_str()
        .unwrap()
        .to_owned();
    vault.lock();
    (disk, lens, item)
}

#[test]
fn runs_the_password_step_apart_from_the_backend() {
    let (disk, lens, item) = small_vault();
    let mut vault = backend::<FastKeys>(&disk);
    let plan = vault.prepare_unlock().unwrap();
    assert_eq!(vault.status(), Status::Locked);
    let opened = plan.open::<FastKeys>(&secret("pw"));
    vault.finish_unlock(plan, opened).unwrap();
    assert_eq!(vault.reveal_item(&lens, &item).unwrap().expose(), "v");
}

#[test]
fn lets_a_lock_during_the_password_step_win() {
    let (disk, lens, item) = small_vault();
    let mut vault = backend::<FastKeys>(&disk);
    let plan = vault.prepare_unlock().unwrap();
    let opened = plan.open::<FastKeys>(&secret("pw"));
    vault.lock();
    assert_eq!(
        vault.finish_unlock(plan, opened),
        Err(UnlockFailure::Failed)
    );
    assert_eq!(vault.status(), Status::Locked);
    assert_eq!(
        vault.reveal_item(&lens, &item).err(),
        Some(VaultError::Locked)
    );

    // Of two unlocks under way, the first to finish wins.
    let first = vault.prepare_unlock().unwrap();
    let second = vault.prepare_unlock().unwrap();
    let opened_first = first.open::<FastKeys>(&secret("pw"));
    let opened_second = second.open::<FastKeys>(&secret("pw"));
    vault.finish_unlock(second, opened_second).unwrap();
    assert_eq!(
        vault.finish_unlock(first, opened_first),
        Err(UnlockFailure::Failed)
    );
    assert_eq!(vault.status(), Status::Unlocked);
}

#[test]
fn saves_a_new_vault_but_keeps_it_locked_after_a_lock_during_create() {
    let disk = Memory::default();
    let mut vault = backend::<FastKeys>(&disk);
    let plan = vault.prepare_create().unwrap();
    let created = FastKeys::create(&secret("pw"));
    vault.lock();
    vault.finish_create(plan, created).unwrap();
    assert_eq!(vault.status(), Status::Locked);
    vault.unlock(&secret("pw")).unwrap();

    // A vault stored while the password step ran is never buried.
    let other = Memory::default();
    let mut first = backend::<FastKeys>(&other);
    let mut second = backend::<FastKeys>(&other);
    let plan = second.prepare_create().unwrap();
    first.create(&secret("first")).unwrap();
    let before = other.0.borrow().data.clone();
    let created = FastKeys::create(&secret("second"));
    assert_eq!(
        second.finish_create(plan, created),
        Err(VaultError::VaultExists)
    );
    assert_eq!(other.0.borrow().data, before);
}

#[test]
fn keeps_both_copies_when_data_is_set_aside_twice_in_the_same_millisecond() {
    let disk = Memory::default();
    disk.0
        .borrow_mut()
        .data
        .insert("still-lenses".into(), "[{\"id\":\"o\"}]".into());
    disk.0
        .borrow_mut()
        .data
        .insert("still-has-pin".into(), "true".into());
    let mut vault = backend::<FastKeys>(&disk);
    assert_eq!(
        vault.set_aside().unwrap(),
        "still-set-aside-2026-09-28T00:00:00.000Z-"
    );
    disk.0
        .borrow_mut()
        .data
        .insert("still-has-pin".into(), "false".into());
    assert_eq!(
        vault.set_aside().unwrap(),
        "still-set-aside-2026-09-28T00:00:00.000Z-2-"
    );
    assert_eq!(
        vault.set_aside().unwrap(),
        "still-set-aside-2026-09-28T00:00:00.000Z-3-"
    );

    let data: BTreeMap<String, String> = disk.0.borrow().data.clone();
    assert_eq!(
        data["still-set-aside-2026-09-28T00:00:00.000Z-still-has-pin"],
        "true"
    );
    assert_eq!(
        data["still-set-aside-2026-09-28T00:00:00.000Z-still-lenses"],
        "[{\"id\":\"o\"}]"
    );
    assert_eq!(
        data["still-set-aside-2026-09-28T00:00:00.000Z-2-still-has-pin"],
        "false"
    );
    assert_eq!(data.len(), 3);
}

// A second unlock while unlocked read the lists before its password step;
// a change saved meanwhile must not be undone by it.
#[test]
fn never_installs_lists_older_than_a_change_saved_during_the_password_step() {
    let (disk, lens, _) = small_vault();
    let mut vault = backend::<FastKeys>(&disk);
    vault.unlock(&secret("pw")).unwrap();
    let plan = vault.prepare_unlock().unwrap();
    let opened = plan.open::<FastKeys>(&secret("pw"));
    let added = vault.create_lens("Added meanwhile").unwrap();
    assert_eq!(
        vault.finish_unlock(plan, opened),
        Err(UnlockFailure::Failed)
    );

    // Still unlocked, with the new Lens, and the next change keeps it.
    vault.create_lens("Next").unwrap();
    let names: Vec<_> = vault
        .view()
        .lenses
        .iter()
        .map(|l| l["name"].clone())
        .collect();
    assert_eq!(names, ["Next", "Added meanwhile", "A"]);
    let stored = disk.0.borrow().data["still-lenses"].clone();
    assert!(stored.contains(&added) && stored.contains(&lens));
}

#[test]
fn never_unlocks_a_vault_set_aside_during_the_password_step() {
    let (disk, _, _) = small_vault();
    let mut vault = backend::<FastKeys>(&disk);
    let plan = vault.prepare_unlock().unwrap();
    let opened = plan.open::<FastKeys>(&secret("pw"));
    vault.set_aside().unwrap();
    assert_eq!(
        vault.finish_unlock(plan, opened),
        Err(UnlockFailure::Failed)
    );
    assert_eq!(vault.status(), Status::Empty);
}

#[test]
fn leaves_a_lens_stored_without_items_as_it_was_when_deleting_from_it() {
    let (disk, _, _) = small_vault();
    let mut vault = backend::<FastKeys>(&disk);
    vault.unlock(&secret("pw")).unwrap();
    vault.lock();
    let lenses = disk.0.borrow().data["still-lenses"].clone();
    let with_bare = lenses.replacen(
        '[',
        "[{\"id\":\"bare\",\"name\":\"Bare\",\"encryptedMasterKey\":\"x\"},",
        1,
    );
    disk.0
        .borrow_mut()
        .data
        .insert("still-lenses".into(), with_bare.clone());
    vault.unlock(&secret("pw")).unwrap();
    assert_eq!(
        vault.delete_item("bare", "anything"),
        Err(VaultError::UnknownItem)
    );
    assert_eq!(disk.0.borrow().data["still-lenses"], with_bare);
}
