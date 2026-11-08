//! Checking a backup before restoring it.

mod common;

use std::sync::Arc;

use common::vault::{FastKeys, Memory};
use still_core::session::SecretText;
use still_core::vault::backend::Backend;
use still_core::vault::backup::{self, BackupError, Summary};

fn secret(text: &str) -> SecretText {
    SecretText::from(text.to_owned())
}

/// A v2 vault's file text: two Lenses (three secrets), one forgotten.
fn a_backup() -> String {
    let disk = Memory::default();
    disk.0.borrow_mut().creates_v2 = true;
    let mut vault = Backend::<Memory, FastKeys>::new(disk.clone(), Arc::new(|| 1_791_460_800_000));
    vault.create(&secret("backup-pass")).unwrap();
    let work = vault.create_lens("Work").unwrap();
    for label in ["A", "B"] {
        vault
            .add_item(&work, label, "password", &secret("v"))
            .unwrap();
    }
    let home = vault.create_lens("Home").unwrap();
    vault.add_item(&home, "C", "note", &secret("v")).unwrap();
    let old = vault.create_lens("Old").unwrap();
    vault.forget_lens(&old).unwrap();
    let text = disk.0.borrow().v2.clone().unwrap();
    text
}

#[test]
fn checks_a_backup_with_its_own_password_and_counts_what_it_holds() {
    let file = backup::parse(&a_backup()).unwrap();
    assert_eq!(
        backup::check::<FastKeys>(&file, &secret("backup-pass")),
        Ok(Summary {
            lenses: 2,
            secrets: 3,
            archived: 1
        })
    );
    assert_eq!(
        backup::check::<FastKeys>(&file, &secret("not-it")),
        Err(BackupError::WrongPassword)
    );
}

#[test]
fn refuses_files_that_are_not_v2_vaults_or_are_damaged() {
    for text in [
        "",
        "{}",
        "not json",
        r#"{"format":"still-vault","formatVersion":1}"#,
    ] {
        assert_eq!(
            backup::parse(text).err(),
            Some(BackupError::NotAVault),
            "{text:?}"
        );
    }
    // A consistent edit to the body: the header reads, the body doesn't open.
    let mut file = backup::parse(&a_backup()).unwrap();
    let last = file.body.len() - 1;
    file.body[last] ^= 1;
    let file = backup::parse(&file.to_json()).unwrap();
    assert_eq!(
        backup::check::<FastKeys>(&file, &secret("backup-pass")),
        Err(BackupError::Damaged)
    );
}

#[test]
fn backs_up_only_an_unlocked_v2_vault_exactly_as_stored() {
    use still_core::vault::backend::VaultError;
    let disk = Memory::default();
    disk.0.borrow_mut().creates_v2 = true;
    let mut vault = Backend::<Memory, FastKeys>::new(disk.clone(), Arc::new(|| 1_791_460_800_000));
    vault.create(&secret("pw")).unwrap();
    vault.create_lens("Work").unwrap();
    let file = vault.backup_file().unwrap();
    assert_eq!(Some(file.to_json()), disk.0.borrow().v2.clone());

    // Not if the file on disk isn't this vault as saved.
    let ours = disk.0.borrow().v2.clone();
    disk.0.borrow_mut().v2 = Some(a_backup());
    assert_eq!(vault.backup_file().err(), Some(VaultError::WriteFailed));
    disk.0.borrow_mut().v2 = ours;

    vault.lock();
    assert_eq!(vault.backup_file().err(), Some(VaultError::Locked));

    let v1 = Memory::default();
    let mut old = Backend::<Memory, FastKeys>::new(v1, Arc::new(|| 1_791_460_800_000));
    old.create(&secret("pw")).unwrap();
    assert_eq!(old.backup_file().err(), Some(VaultError::NeedsUpgrade));
}
