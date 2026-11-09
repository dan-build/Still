//! A secret's fields that this version doesn't know about (added by a newer
//! version, say) survive every change this version makes: editing the
//! secret, deleting it and putting it back, and forgetting and restoring its
//! Lens. A newer version's fields must never be lost to an older one.
//!
//! And a password's username and website (v0.11.0): stored on the secret,
//! shown in the view, checked, and copied.

mod common;

use std::sync::Arc;

use common::vault::{FastKeys, Memory};
use serde_json::{json, Value};
use still_core::session::SecretText;
use still_core::vault::backend::{Backend, Details, VaultError, URL_MAX, USERNAME_MAX};

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

fn unlocked() -> (Memory, Backend<Memory, FastKeys>, String) {
    let disk = Memory::default();
    let mut vault = Backend::<Memory, FastKeys>::new(disk.clone(), Arc::new(|| NOW));
    vault.create(&secret("pw-123456")).unwrap();
    let lens = vault.create_lens("Work").unwrap();
    (disk, vault, lens)
}

fn details(username: &str, url: &str) -> Details {
    Details {
        username: Some(username.into()),
        url: Some(url.into()),
    }
}

#[test]
fn stores_a_passwords_username_and_website_trimmed() {
    let (disk, mut vault, lens) = unlocked();
    vault
        .add_item_with(
            &lens,
            "Shop",
            "password",
            &secret("v"),
            &details("  me@example.com ", "\u{3000}https://shop.example/login\n"),
        )
        .unwrap();
    let item = &stored_items(&disk, "still-lenses")[0];
    let keys: Vec<&String> = item.as_object().unwrap().keys().collect();
    assert_eq!(
        keys,
        ["id", "label", "type", "encryptedValue", "username", "url"]
    );
    assert_eq!(item["username"], "me@example.com");
    assert_eq!(item["url"], "https://shop.example/login");

    let view = vault.view();
    let shown = &view.lenses[0]["items"][0];
    assert_eq!(shown["username"], "me@example.com");
    assert_eq!(shown["url"], "https://shop.example/login");
    assert!(shown.get("encryptedValue").is_none());

    let id = shown["id"].as_str().unwrap().to_owned();
    assert_eq!(
        vault.item_field(&lens, &id, "username").unwrap().expose(),
        "me@example.com"
    );
    assert_eq!(
        vault.item_field(&lens, &id, "url").unwrap().expose(),
        "https://shop.example/login"
    );
    // Only those two fields, never the value or anything else.
    for other in ["encryptedValue", "label", "id", ""] {
        assert_eq!(
            vault.item_field(&lens, &id, other).err(),
            Some(VaultError::UnknownItem)
        );
    }
}

#[test]
fn keeps_no_username_or_website_when_blank_or_not_a_password() {
    let (disk, mut vault, lens) = unlocked();
    vault
        .add_item_with(
            &lens,
            "Blank",
            "password",
            &secret("v"),
            &details(" ", "\n"),
        )
        .unwrap();
    for item_type in ["key", "note"] {
        vault
            .add_item_with(
                &lens,
                item_type,
                item_type,
                &secret("v"),
                &details("me", "https://x"),
            )
            .unwrap();
    }
    for item in stored_items(&disk, "still-lenses") {
        assert!(
            item.get("username").is_none() && item.get("url").is_none(),
            "{item}"
        );
    }
    let id = vault.view().lenses[0]["items"][0]["id"]
        .as_str()
        .unwrap()
        .to_owned();
    assert_eq!(
        vault.item_field(&lens, &id, "username").err(),
        Some(VaultError::UnknownItem)
    );
    // The plain add_item, as before, stores neither.
    vault
        .add_item(&lens, "Plain", "password", &secret("v"))
        .unwrap();
    let plain = stored_items(&disk, "still-lenses").pop().unwrap();
    assert_eq!(plain.as_object().unwrap().len(), 4);
}

#[test]
fn refuses_a_username_or_website_that_is_too_long_changing_nothing() {
    let (disk, mut vault, lens) = unlocked();
    let before = disk.0.borrow().data.clone();
    // Counted as the page counts: an emoji is two UTF-16 units.
    let emoji = |n: usize| "\u{1F510}".repeat(n);
    assert_eq!(
        vault
            .add_item_with(
                &lens,
                "L",
                "password",
                &secret("v"),
                &details(&emoji(USERNAME_MAX / 2 + 1), "")
            )
            .err(),
        Some(VaultError::UsernameTooLong)
    );
    assert_eq!(
        vault
            .add_item_with(
                &lens,
                "L",
                "password",
                &secret("v"),
                &details("", &"u".repeat(URL_MAX + 1))
            )
            .err(),
        Some(VaultError::UrlTooLong)
    );
    assert_eq!(disk.0.borrow().data, before);
    assert_eq!(VaultError::UsernameTooLong.code(), "username-too-long");
    assert_eq!(VaultError::UrlTooLong.code(), "url-too-long");

    // At the limits, they're kept.
    vault
        .add_item_with(
            &lens,
            "L",
            "password",
            &secret("v"),
            &details(&emoji(USERNAME_MAX / 2), &"u".repeat(URL_MAX)),
        )
        .unwrap();
}

#[test]
fn sets_changes_and_removes_them_when_editing() {
    let (disk, mut vault, lens) = unlocked();
    vault
        .add_item_with(
            &lens,
            "Shop",
            "password",
            &secret("v"),
            &details("me", "https://a"),
        )
        .unwrap();
    let id = vault.view().lenses[0]["items"][0]["id"]
        .as_str()
        .unwrap()
        .to_owned();
    let item = || stored_items(&disk, "still-lenses")[0].clone();

    // Without details, as before: both kept.
    vault
        .update_item(&lens, &id, "Shop 2", "password", None)
        .unwrap();
    assert_eq!(
        (item()["username"].clone(), item()["url"].clone()),
        (json!("me"), json!("https://a"))
    );

    // Changed in place, and one removed by leaving it blank.
    vault
        .update_item_with(
            &lens,
            &id,
            "Shop 2",
            "password",
            None,
            Some(&details("you", "")),
        )
        .unwrap();
    assert_eq!(item()["username"], "you");
    assert!(item().get("url").is_none());
    let keys: Vec<String> = item().as_object().unwrap().keys().cloned().collect();
    assert_eq!(keys, ["id", "label", "type", "encryptedValue", "username"]);

    // Made a note: a note has no username or website.
    vault
        .update_item_with(
            &lens,
            &id,
            "Shop 2",
            "note",
            None,
            Some(&details("you", "https://b")),
        )
        .unwrap();
    assert!(item().get("username").is_none() && item().get("url").is_none());

    // A refused edit changes nothing.
    vault
        .update_item_with(
            &lens,
            &id,
            "Shop 2",
            "password",
            None,
            Some(&details("me", "")),
        )
        .unwrap();
    let before = item();
    assert_eq!(
        vault
            .update_item_with(
                &lens,
                &id,
                "Other",
                "password",
                None,
                Some(&details(&"x".repeat(USERNAME_MAX + 1), ""))
            )
            .err(),
        Some(VaultError::UsernameTooLong)
    );
    assert_eq!(item(), before);

    // Nothing to read while locked.
    vault.lock();
    assert_eq!(
        vault.item_field(&lens, &id, "username").err(),
        Some(VaultError::Locked)
    );
}
