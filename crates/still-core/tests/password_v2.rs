//! Changing a v2 vault's master password with the real keys: the same app
//! key under a new password and settings, the lists unchanged, and the old
//! password refused afterwards.

use still_core::session::{SecretText, SessionError, Unlocked};
use still_core::v2;

fn secret(text: &str) -> SecretText {
    SecretText::from(text.to_owned())
}

#[test]
fn changes_the_password_and_settings_keeping_the_vault() {
    let (created, file) = Unlocked::create_v2(&secret("old-pass-1")).unwrap();
    let body = v2::Body {
        lenses: r#"[{"id":"a","name":"Work"}]"#.into(),
        bin: "[]".into(),
    };
    let file = created.seal_v2(&file, &body);

    // A wrong current password changes nothing.
    let wrong = Unlocked::change_password_v2(
        &file,
        &secret("not-it"),
        &secret("new-pass-2"),
        v2::Kdf::new_sensitive(),
        &body,
    );
    assert!(matches!(wrong, Err(SessionError::WrongPassword)));

    let stronger = v2::Kdf::new(v2::OPS_MIN * 2, v2::MEM_MIN).unwrap();
    let (keys, changed) = Unlocked::change_password_v2(
        &file,
        &secret("old-pass-1"),
        &secret("new-pass-2"),
        stronger,
        &body,
    )
    .unwrap();
    assert!(keys.same_app_key(&created));
    assert_eq!(changed.kdf.ops_limit, v2::OPS_MIN * 2);
    assert_ne!(changed.kdf.salt, file.kdf.salt);
    assert_eq!(changed.migrated_from, file.migrated_from);

    // It writes and reads back as a v2 file, opens with the new password to
    // the same app key and the same lists, and no longer with the old one.
    let changed = v2::File::parse(&changed.to_json()).unwrap();
    let (reopened, lists) = Unlocked::open_v2(&changed, &secret("new-pass-2")).unwrap();
    assert!(reopened.same_app_key(&created));
    assert_eq!(
        (lists.lenses.as_str(), lists.bin.as_str()),
        (body.lenses.as_str(), body.bin.as_str())
    );
    assert!(matches!(
        Unlocked::open_v2(&changed, &secret("old-pass-1")),
        Err(SessionError::WrongPassword)
    ));
}

#[test]
fn offers_only_settings_inside_the_allowed_range() {
    assert!(v2::Kdf::new(v2::OPS_MIN, v2::MEM_MIN).is_ok());
    assert!(v2::Kdf::new(v2::OPS_MAX, v2::MEM_MAX).is_ok());
    assert!(v2::Kdf::new(v2::OPS_MIN - 1, v2::MEM_MIN).is_err());
    assert!(v2::Kdf::new(v2::OPS_MAX + 1, v2::MEM_MIN).is_err());
    assert!(v2::Kdf::new(v2::OPS_MIN, v2::MEM_MIN - 1).is_err());
    assert!(v2::Kdf::new(v2::OPS_MIN, v2::MEM_MAX + 1).is_err());
    // Each gets its own salt.
    assert_ne!(v2::Kdf::new_sensitive().salt, v2::Kdf::new_sensitive().salt);
}
