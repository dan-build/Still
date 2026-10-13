//! Where the vault comes from when Still starts: the vault file, or, once,
//! the localStorage of versions before the file. Only the page can read
//! that localStorage, so it sends the old values and the marker; this
//! decides, and says what marker to write. The old copy is never changed
//! or deleted.
//!
//! - A vault file: use it. If an older version changed the old copy since
//!   the move, say so once (the marker is updated to the copy as it is).
//! - No file, old data, no marker: copy the old values into a new file,
//!   unchanged (the store checks them back), then have the marker set.
//! - No file, but the marker: the file was moved and has gone missing.
//!   Don't quietly bring back the older copy; the user chooses.
//! - Nothing anywhere: a new install; the file appears with the first vault.

use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use still_core::sodium;
use still_core::vault::time;

use crate::store::{AppStore, Loaded, Values};

/// The localStorage key the page keeps the marker under, once the vault moved.
pub const MOVED_MARKER: &str = "still-moved-to-file";

/// The marker: when the vault moved, and a fingerprint of what was moved.
#[derive(Serialize, Deserialize, Debug, Clone, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct Moved {
    pub moved_at: String,
    /// SHA-256 of the values that were moved, to notice later changes by older versions.
    pub fingerprint: String,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Startup {
    /// The vault file is ready (or there is none yet, on a new install).
    Ready {
        notice: Option<&'static str>,
        /// Written to localStorage under MOVED_MARKER by the page.
        marker: Option<Moved>,
    },
    AlreadyOpen,
    /// The vault file can't be read. `can_restore`: the v1 file a
    /// conversion kept is there, and the user may put it back.
    Unreadable {
        can_restore: bool,
    },
    /// The vault file is v1, but this vault was converted to v2 on
    /// `converted_at`: an older or changed copy is in its place. It opens
    /// only if the user says so, and is then never converted silently.
    OldFormat {
        converted_at: String,
    },
    FileMissing {
        moved_at: String,
    },
    Failed,
}

impl Startup {
    /// What the page gets: {kind, notice?, movedAt?, marker?}, the marker as
    /// the exact text to store.
    pub fn to_json(&self) -> Value {
        match self {
            Self::Ready { notice, marker } => {
                let mut ready = json!({ "kind": "ready" });
                if let Some(notice) = notice {
                    ready["notice"] = json!(notice);
                }
                if let Some(marker) = marker {
                    let text = serde_json::to_string(marker).expect("a marker serialises");
                    ready["marker"] = json!(text);
                }
                ready
            }
            Self::AlreadyOpen => json!({ "kind": "already-open" }),
            Self::Unreadable { can_restore } => {
                json!({ "kind": "unreadable", "canRestore": can_restore })
            }
            Self::OldFormat { converted_at } => {
                json!({ "kind": "old-format", "convertedAt": converted_at })
            }
            Self::FileMissing { moved_at } => {
                json!({ "kind": "file-missing", "movedAt": moved_at })
            }
            Self::Failed => json!({ "kind": "failed" }),
        }
    }
}

/// Every value an older version stored (they all start with "still-"),
/// except the markers this version sets (moved, and converted to v2).
fn legacy_values(legacy: Values) -> Values {
    legacy
        .into_iter()
        .filter(|(key, _)| {
            key.starts_with("still-") && key != MOVED_MARKER && key != "still-converted-v2"
        })
        .collect()
}

/// SHA-256 of the values as `JSON.stringify` writes `[[key, value], ...]`,
/// keys sorted as JavaScript sorts strings (by UTF-16 code units), so it
/// matches the fingerprints earlier versions wrote.
pub fn fingerprint(values: &Values) -> String {
    let mut pairs: Vec<(&str, &str)> = values
        .iter()
        .map(|(k, v)| (k.as_str(), v.as_str()))
        .collect();
    pairs.sort_by(|a, b| a.0.encode_utf16().cmp(b.0.encode_utf16()));
    let canonical = serde_json::to_string(&pairs).expect("strings serialise");
    sodium::sha256(canonical.as_bytes())
        .iter()
        .map(|b| format!("{b:02x}"))
        .collect()
}

/// The marker as the page found it, read as earlier versions read it: a
/// JSON object whose movedAt and fingerprint are strings (a repeated key
/// keeps its last value). Anything else counts as no marker.
fn read_marker(text: Option<&str>) -> Option<Moved> {
    let value: Value = serde_json::from_str(text?).ok()?;
    let field = |name: &str| Some(value.as_object()?.get(name)?.as_str()?.to_owned());
    Some(Moved {
        moved_at: field("movedAt")?,
        fingerprint: field("fingerprint")?,
    })
}

/// When the conversion marker (localStorage `still-converted-v2`, which the
/// page keeps once the vault was converted to v2) says it was converted.
fn read_converted(text: Option<&str>) -> Option<String> {
    let value: Value = serde_json::from_str(text?).ok()?;
    Some(value.as_object()?.get("convertedAt")?.as_str()?.to_owned())
}

pub fn open(
    store: &AppStore,
    legacy: Values,
    marker: Option<&str>,
    converted: Option<&str>,
    now_ms: i64,
) -> Startup {
    if store.already_open {
        return Startup::AlreadyOpen;
    }
    let legacy = legacy_values(legacy);
    let marker = read_marker(marker);
    let loaded = store.store().load();
    match (loaded, marker) {
        (Loaded::Unreadable, _) => Startup::Unreadable {
            can_restore: store.store().kept_v1().is_some(),
        },
        (Loaded::Values(_), _) if read_converted(converted).is_some() => Startup::OldFormat {
            converted_at: read_converted(converted).unwrap_or_default(),
        },
        (Loaded::Values(_) | Loaded::V2(_), Some(marker))
            if marker.fingerprint != fingerprint(&legacy) =>
        {
            // Show once: the marker now matches the old copy as it is.
            let marker = Moved {
                fingerprint: fingerprint(&legacy),
                ..marker
            };
            Startup::Ready {
                notice: Some("old-copy-changed"),
                marker: Some(marker),
            }
        }
        (Loaded::Values(_) | Loaded::V2(_), _) => Startup::Ready {
            notice: None,
            marker: None,
        },
        (Loaded::Nothing, Some(marker)) => Startup::FileMissing {
            moved_at: marker.moved_at,
        },
        (Loaded::Nothing, None) if legacy.is_empty() => Startup::Ready {
            notice: None,
            marker: None,
        },
        (Loaded::Nothing, None) => move_old_copy(store, legacy, now_ms),
    }
}

/// Puts back the v1 file a conversion kept, over a vault file that can't be
/// read (which is kept too, never deleted). The page then forgets the
/// conversion marker: going back was the user's choice.
pub fn restore_kept_v1(store: &AppStore) -> Startup {
    if store.already_open {
        return Startup::AlreadyOpen;
    }
    match store.store().restore_v1() {
        Ok(()) => Startup::Ready {
            notice: Some("restored"),
            marker: None,
        },
        Err(_) => Startup::Failed,
    }
}

/// Copies the old values into a new vault file, then has the marker set.
/// Also the user's choice on the file-missing screen.
pub fn move_old_copy(store: &AppStore, legacy: Values, now_ms: i64) -> Startup {
    if store.already_open {
        return Startup::AlreadyOpen;
    }
    let values = legacy_values(legacy);
    if store.store().import_legacy(values.clone()).is_err() {
        return Startup::Failed;
    }
    Startup::Ready {
        notice: Some("moved"),
        marker: Some(Moved {
            moved_at: time::to_iso(now_ms),
            fingerprint: fingerprint(&values),
        }),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::PathBuf;

    const NOW: i64 = 1_791_194_400_000; // 2026-10-05T10:00:00.000Z

    /// A fresh vault folder under the system temp dir, removed when dropped.
    struct TempDir(PathBuf);

    impl TempDir {
        fn new() -> Self {
            let mut id = [0u8; 8];
            sodium::random_bytes(&mut id);
            let hex: String = id.iter().map(|b| format!("{b:02x}")).collect();
            Self(std::env::temp_dir().join(format!("still-startup-test-{hex}")))
        }
        fn store(&self) -> AppStore {
            AppStore::open(self.0.join("vault"))
        }
    }

    impl Drop for TempDir {
        fn drop(&mut self) {
            let _ = std::fs::remove_dir_all(&self.0);
        }
    }

    /// The five localStorage values of the vault exported from a release build.
    fn real_vault() -> Values {
        serde_json::from_str(include_str!("../../fixtures/vault-v1-real/vault.json")).unwrap()
    }

    fn with(values: &Values, extra: &[(&str, &str)]) -> Values {
        let mut values = values.clone();
        values.extend(extra.iter().map(|(k, v)| (k.to_string(), v.to_string())));
        values
    }

    fn stored(store: &AppStore) -> Option<Values> {
        match store.store().load() {
            Loaded::Values(values) => Some(values),
            _ => None,
        }
    }

    fn marker_text(startup: &Startup) -> String {
        startup.to_json()["marker"].as_str().unwrap().to_owned()
    }

    // The fingerprints earlier versions wrote, from startup.ts's fingerprint()
    // in Node, so a marker set by an older version still matches.
    #[test]
    fn fingerprints_exactly_as_the_typescript_code_did() {
        let values = |pairs: &[(&str, &str)]| with(&Values::new(), pairs);
        assert_eq!(
            fingerprint(&Values::new()),
            "4f53cda18c2baa0c0354bb5f9a3ecbe5ed12ab4d8e11ba873c2f11161202b945"
        );
        assert_eq!(
            fingerprint(&values(&[
                ("still-salt", "AAAA"),
                ("still-lenses", "[{\"id\":\"a\"}]"),
                ("still-has-pin", "false"),
            ])),
            "755e4d895a536bc63fc3bb8a2f0cd6c74e75afeafd99762937db74cbb93d3299"
        );
        // JavaScript sorts 🔐 (a surrogate pair) before ～ (U+FF5E); by code
        // point it would come after.
        assert_eq!(
            fingerprint(&values(&[
                ("still-z", "1"),
                ("still-\u{1F510}", "emoji key"),
                ("still-\u{FF5E}", "fullwidth"),
                ("still-é", "e acute"),
                ("still-A", "upper"),
                ("still-\n", "ctrl \u{1} \"q\" \\ / \u{2028}"),
            ])),
            "5164d631da22cd886095b4eb60204ecea0a4db38978bc02944e024df3de343d1"
        );
        assert_eq!(
            fingerprint(&real_vault()),
            "c0ae977f4354c9642580226501b956d57d3d879ef316a332d1a5a0460462d576"
        );
    }

    #[test]
    fn starts_a_new_install_with_no_file_writing_nothing_yet() {
        let tmp = TempDir::new();
        let store = tmp.store();
        let legacy = with(&Values::new(), &[("unrelated-app-key", "x")]);
        assert_eq!(
            open(&store, legacy, None, None, NOW),
            Startup::Ready {
                notice: None,
                marker: None
            }
        );
        assert_eq!(stored(&store), None);
    }

    #[test]
    fn moves_the_old_vault_into_the_file_once_unchanged() {
        let tmp = TempDir::new();
        let store = tmp.store();
        let set_aside = [(
            "still-set-aside-2026-09-01T00:00:00.000Z-still-salt",
            "old-salt",
        )];
        let legacy = with(&real_vault(), &set_aside);
        let started = open(
            &store,
            with(&legacy, &[("unrelated-app-key", "x")]),
            None,
            None,
            NOW,
        );

        assert_eq!(started.to_json()["notice"], "moved");
        assert_eq!(stored(&store), Some(legacy.clone()));
        let marker = marker_text(&started);
        assert_eq!(
            marker,
            format!(
                r#"{{"movedAt":"2026-10-05T10:00:00.000Z","fingerprint":"{}"}}"#,
                fingerprint(&legacy)
            )
        );

        // The next start uses the file, with no notice.
        let again = open(
            &store,
            with(&legacy, &[(MOVED_MARKER, &marker)]),
            Some(&marker),
            None,
            NOW,
        );
        assert_eq!(again.to_json(), json!({ "kind": "ready" }));
    }

    #[test]
    fn uses_the_file_not_the_old_copy_from_then_on() {
        let tmp = TempDir::new();
        let store = tmp.store();
        let marker = marker_text(&open(&store, real_vault(), None, None, NOW));
        let mut changes = std::collections::BTreeMap::new();
        changes.insert("still-lenses".to_owned(), Some("[]".to_owned()));
        store.store().write(&changes).unwrap();

        assert_eq!(
            open(&store, real_vault(), Some(&marker), None, NOW).to_json(),
            json!({ "kind": "ready" })
        );
        assert_eq!(stored(&store).unwrap()["still-lenses"], "[]");
    }

    #[test]
    fn says_once_when_an_older_version_changed_the_old_copy_after_the_move() {
        let tmp = TempDir::new();
        let store = tmp.store();
        let marker = marker_text(&open(&store, real_vault(), None, None, NOW));
        let changed = with(&real_vault(), &[("still-lenses", "[]")]);

        let started = open(&store, changed.clone(), Some(&marker), None, NOW + 1000);
        assert_eq!(started.to_json()["notice"], "old-copy-changed");
        // The marker keeps when the vault moved, with the copy as it is now.
        let updated = marker_text(&started);
        assert_eq!(
            updated,
            format!(
                r#"{{"movedAt":"2026-10-05T10:00:00.000Z","fingerprint":"{}"}}"#,
                fingerprint(&changed)
            )
        );
        assert_eq!(
            open(&store, changed, Some(&updated), None, NOW).to_json(),
            json!({ "kind": "ready" })
        );
        assert_eq!(stored(&store), Some(real_vault()));
    }

    #[test]
    fn never_quietly_brings_back_the_old_copy_when_the_moved_file_has_gone() {
        let tmp = TempDir::new();
        let store = tmp.store();
        let marker = marker_text(&open(&store, real_vault(), None, None, NOW));
        drop(store);
        std::fs::remove_dir_all(tmp.0.join("vault")).unwrap();
        let store = tmp.store();

        assert_eq!(
            open(&store, real_vault(), Some(&marker), None, NOW),
            Startup::FileMissing {
                moved_at: "2026-10-05T10:00:00.000Z".into()
            }
        );
        assert_eq!(stored(&store), None);
        // Only when the user chooses to.
        assert_eq!(
            move_old_copy(&store, real_vault(), NOW).to_json()["notice"],
            "moved"
        );
        assert_eq!(stored(&store), Some(real_vault()));
    }

    #[test]
    fn reports_a_damaged_file_another_open_copy_and_a_failed_move() {
        let tmp = TempDir::new();
        let store = tmp.store();
        std::fs::write(tmp.0.join("vault").join("vault.json"), "{oops").unwrap();
        assert_eq!(
            open(&store, real_vault(), None, None, NOW),
            Startup::Unreadable { can_restore: false }
        );
        // A move never writes over it.
        assert_eq!(move_old_copy(&store, real_vault(), NOW), Startup::Failed);

        let second = tmp.store();
        assert!(second.already_open);
        assert_eq!(
            open(&second, real_vault(), None, None, NOW),
            Startup::AlreadyOpen
        );
        assert_eq!(
            move_old_copy(&second, real_vault(), NOW),
            Startup::AlreadyOpen
        );
    }

    #[test]
    fn ignores_a_marker_it_cannot_read() {
        for text in [
            "",
            "null",
            "{oops",
            r#"{"movedAt":1,"fingerprint":"x"}"#,
            "[]",
            r#"["t","f"]"#,
        ] {
            assert_eq!(read_marker(Some(text)), None, "{text}");
        }
        assert_eq!(
            read_marker(Some(r#"{"movedAt":"t","fingerprint":"f","extra":1}"#)),
            Some(Moved {
                moved_at: "t".into(),
                fingerprint: "f".into()
            })
        );
    }

    #[test]
    fn keeps_the_last_value_of_a_repeated_marker_key_as_javascript_did() {
        assert_eq!(
            read_marker(Some(
                r#"{"movedAt":"old","fingerprint":"f","movedAt":"new"}"#
            )),
            Some(Moved {
                moved_at: "new".into(),
                fingerprint: "f".into()
            })
        );
    }

    // What the page reads: the kind, and movedAt in camelCase.
    #[test]
    fn tells_the_page_each_outcome() {
        let missing = Startup::FileMissing {
            moved_at: "t".into(),
        };
        assert_eq!(
            missing.to_json(),
            json!({ "kind": "file-missing", "movedAt": "t" })
        );
        assert_eq!(
            Startup::AlreadyOpen.to_json(),
            json!({ "kind": "already-open" })
        );
        assert_eq!(
            Startup::Unreadable { can_restore: true }.to_json(),
            json!({ "kind": "unreadable", "canRestore": true })
        );
        assert_eq!(
            Startup::OldFormat {
                converted_at: "t".into()
            }
            .to_json(),
            json!({ "kind": "old-format", "convertedAt": "t" })
        );
        assert_eq!(Startup::Failed.to_json(), json!({ "kind": "failed" }));
    }

    // A move that fails sets no marker, so it is tried again next time.
    #[cfg(unix)]
    #[test]
    fn sets_no_marker_when_the_move_fails() {
        use std::os::unix::fs::PermissionsExt;
        let tmp = TempDir::new();
        let store = tmp.store();
        let dir = tmp.0.join("vault");
        std::fs::set_permissions(&dir, std::fs::Permissions::from_mode(0o500)).unwrap();
        let started = open(&store, real_vault(), None, None, NOW);
        std::fs::set_permissions(&dir, std::fs::Permissions::from_mode(0o700)).unwrap();

        assert_eq!(started, Startup::Failed);
        assert!(started.to_json().get("marker").is_none());
        assert_eq!(stored(&store), None);
        assert_eq!(
            open(&store, real_vault(), None, None, NOW).to_json()["notice"],
            "moved"
        );
    }

    const CONVERTED: &str = r#"{"convertedAt":"2026-10-13T09:00:00.000Z","fingerprint":"ab"}"#;

    // After a conversion, a v1 file in the vault's place asks before it opens.
    #[test]
    fn asks_before_opening_an_old_format_vault_after_a_conversion() {
        let tmp = TempDir::new();
        let store = tmp.store();
        let marker = marker_text(&open(&store, real_vault(), None, None, NOW));
        assert_eq!(
            open(&store, real_vault(), Some(&marker), Some(CONVERTED), NOW),
            Startup::OldFormat {
                converted_at: "2026-10-13T09:00:00.000Z".into()
            }
        );
        // Without the conversion marker (or with one it can't read), as before.
        for converted in [None, Some("{oops"), Some(r#"{"convertedAt":1}"#)] {
            assert_eq!(
                open(&store, real_vault(), Some(&marker), converted, NOW).to_json(),
                json!({ "kind": "ready" })
            );
        }
    }

    #[test]
    fn opens_a_v2_vault_as_usual_with_the_conversion_marker() {
        let tmp = TempDir::new();
        let store = tmp.store();
        let body = still_core::v2::Body {
            lenses: "[]".into(),
            bin: "[]".into(),
        };
        let file = still_core::v2::seal_file(
            &still_core::crypto::Key::random(),
            &still_core::crypto::Key::random(),
            still_core::v2::Kdf::new_sensitive(),
            &body,
            None,
        );
        store.store().write_v2(&file).unwrap();
        assert_eq!(
            open(&store, Values::new(), None, Some(CONVERTED), NOW).to_json(),
            json!({ "kind": "ready" })
        );
    }

    // A v2 file that can't be read, next to the kept v1 file: the user can
    // put the v1 file back, and the unreadable one is kept too.
    #[test]
    fn offers_to_restore_the_kept_v1_file_over_an_unreadable_vault() {
        let tmp = TempDir::new();
        let store = tmp.store();
        let dir = tmp.0.join("vault");
        let v1 = include_str!("../../fixtures/vault-v1-real/vault.json");
        let v1_file = format!(
            r#"{{"format":"still-vault","formatVersion":1,"migratedFrom":"localStorage","data":{v1}}}"#
        );
        std::fs::write(dir.join("vault-v1.json"), &v1_file).unwrap();
        std::fs::write(dir.join("vault.json"), "{damaged v2").unwrap();

        assert_eq!(
            open(&store, real_vault(), None, None, NOW),
            Startup::Unreadable { can_restore: true }
        );
        assert_eq!(
            restore_kept_v1(&store).to_json(),
            json!({ "kind": "ready", "notice": "restored" })
        );
        assert_eq!(stored(&store), Some(real_vault()));
        assert_eq!(
            std::fs::read_to_string(dir.join("vault-unreadable.json")).unwrap(),
            "{damaged v2"
        );
        assert_eq!(
            std::fs::read_to_string(dir.join("vault-v1.json")).unwrap(),
            v1_file
        );

        // Only over an unreadable vault: never over one that opens.
        assert_eq!(restore_kept_v1(&store), Startup::Failed);
        assert_eq!(stored(&store), Some(real_vault()));
    }

    #[test]
    fn offers_no_restore_without_a_kept_v1_file() {
        let tmp = TempDir::new();
        let store = tmp.store();
        std::fs::write(tmp.0.join("vault").join("vault.json"), "{damaged").unwrap();
        assert_eq!(
            open(&store, Values::new(), None, None, NOW),
            Startup::Unreadable { can_restore: false }
        );
        assert_eq!(restore_kept_v1(&store), Startup::Failed);
        assert_eq!(
            std::fs::read_to_string(tmp.0.join("vault").join("vault.json")).unwrap(),
            "{damaged"
        );
    }

    // The conversion marker is this version's, not the old copy's: setting
    // it must not look like an older version changed its copy.
    #[test]
    fn leaves_the_conversion_marker_out_of_the_old_copy() {
        let tmp = TempDir::new();
        let store = tmp.store();
        let marker = marker_text(&open(&store, real_vault(), None, None, NOW));
        let with_marker = with(&real_vault(), &[("still-converted-v2", CONVERTED)]);
        assert_eq!(
            open(&store, with_marker, Some(&marker), None, NOW).to_json(),
            json!({ "kind": "ready" })
        );
    }
}
