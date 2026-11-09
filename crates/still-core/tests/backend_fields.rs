//! A secret's fields that this version doesn't know about (added by a newer
//! version, say) survive every change this version makes: editing the
//! secret, deleting it and putting it back, and forgetting and restoring its
//! Lens. A newer version's fields must never be lost to an older one.

mod common;

use std::sync::Arc;

use common::vault::{FastKeys, Memory};
use serde_json::{json, Value};
use still_core::session::SecretText;
use still_core::vault::backend::Backend;

const NOW: i64 = 1_791_460_800_000; // 2026-10-08T12:00:00.000Z

fn secret(text: &str) -> SecretText {
    SecretText::from(text.to_owned())
}

fn stored_items(disk: &Memory, list: &str) -> Vec<Value> {
    let lists: Value = serde_json::from_str(&disk.0.borrow().data[list]).unwrap();
    lists[0]["items"].as_array().unwrap().clone()
}

#[test]
fn keeps_secret_fields_it_does_not_know_through_every_change() {
    let disk = Memory::default();
    let mut vault = Backend::<Memory, FastKeys>::new(disk.clone(), Arc::new(|| NOW));
    vault.create(&secret("pw-123456")).unwrap();
    let lens = vault.create_lens("Work").unwrap();
    vault
        .add_item(&lens, "Email", "password", &secret("v"))
        .unwrap();
    vault.lock();

    // A newer version added two fields to the secret.
    let future = json!({ "nested": [1, "two"], "n": 1.5 });
    {
        let mut disk = disk.0.borrow_mut();
        let mut lists: Value = serde_json::from_str(&disk.data["still-lenses"]).unwrap();
        let item = lists[0]["items"][0].as_object_mut().unwrap();
        item.insert("username".into(), json!("me@example.com"));
        item.insert("futureField".into(), future.clone());
        disk.data.insert(
            "still-lenses".into(),
            serde_json::to_string(&lists).unwrap(),
        );
    }
    let keeps = |items: &[Value]| {
        let item = items.iter().find(|i| i["label"] != "Other").unwrap();
        assert_eq!(item["username"], "me@example.com");
        assert_eq!(item["futureField"], future);
        // In their place: after the fields this version writes.
        let keys: Vec<&String> = item.as_object().unwrap().keys().collect();
        assert_eq!(
            keys,
            [
                "id",
                "label",
                "type",
                "encryptedValue",
                "username",
                "futureField"
            ]
        );
    };
    vault.unlock(&secret("pw-123456")).unwrap();
    let id = vault.view().lenses[0]["items"][0]["id"]
        .as_str()
        .unwrap()
        .to_owned();

    // Edited: a new label and type, the value kept, then a new value.
    vault
        .update_item(&lens, &id, "Renamed", "key", None)
        .unwrap();
    keeps(&stored_items(&disk, "still-lenses"));
    vault
        .update_item(&lens, &id, "Renamed", "password", Some(&secret("new")))
        .unwrap();
    keeps(&stored_items(&disk, "still-lenses"));

    // Another secret added beside it.
    vault
        .add_item(&lens, "Other", "note", &secret("o"))
        .unwrap();
    keeps(&stored_items(&disk, "still-lenses"));

    // Deleted, then put back with Undo.
    vault.delete_item(&lens, &id).unwrap();
    vault.restore_item(&lens, &id).unwrap();
    keeps(&stored_items(&disk, "still-lenses"));

    // Its Lens forgotten into the Archive, then restored.
    vault.forget_lens(&lens).unwrap();
    keeps(&stored_items(&disk, "still-recycle-bin"));
    vault.restore_lens(&lens).unwrap();
    keeps(&stored_items(&disk, "still-lenses"));

    // And after a restart.
    vault.lock();
    let mut again = Backend::<Memory, FastKeys>::new(disk.clone(), Arc::new(|| NOW));
    again.unlock(&secret("pw-123456")).unwrap();
    keeps(&stored_items(&disk, "still-lenses"));
    assert_eq!(again.reveal_item(&lens, &id).unwrap().expose(), "new");
}
