//! Where the vault comes from when Still starts: the vault file, or, once,
//! the localStorage of versions before the file. Only the page can read
//! that localStorage, so it sends the old values (and the two markers that
//! versions up to 0.8 kept there, taken into `state.json` once; see
//! record.rs). The old copy is never changed or deleted.
//!
//! `open` gathers what's there (`Inputs`) and `decide` picks the outcome
//! from this table, top row first ("·" matches anything):
//!
//! | another copy open | vault.json | not the saved one | kept copy | moved marker      | converted marker | old copy | outcome                       |
//! |-------------------|------------|-------------------|-----------|-------------------|------------------|----------|-------------------------------|
//! | yes               | ·          | ·                 | ·         | ·                 | ·                | ·        | already open                  |
//! | no                | unreadable | ·                 | k         | ·                 | ·                | ·        | unreadable, can restore if k  |
//! | no                | v1         | ·                 | ·         | ·                 | yes              | ·        | old format: ask first         |
//! | no                | v1 or v2   | yes (password p)  | ·         | ·                 | ·                | ·        | replaced: ask first           |
//! | no                | v1 or v2   | no                | ·         | differs from copy | ·                | ·        | ready, say once it changed    |
//! | no                | v1 or v2   | no                | ·         | ·                 | ·                | ·        | ready                         |
//! | no                | missing    | ·                 | yes       | ·                 | ·                | ·        | unreadable, can restore       |
//! | no                | missing    | ·                 | no        | yes               | ·                | ·        | file missing: user chooses    |
//! | no                | missing    | ·                 | no        | no                | ·                | empty    | ready (a new install)         |
//! | no                | missing    | ·                 | no        | no                | ·                | values   | move the old copy into a file |
//!
//! - A kept copy is what `Store::restore_source` would put back: a readable
//!   v2 `.bak`, else the v1 file a conversion kept. With no vault file it's
//!   newer than any localStorage copy, so it's offered first.
//! - The markers are the record's (record.rs). The first start without one
//!   takes the page's localStorage markers into it.
//! - "Not the saved one": the vault file isn't the one Still saved last
//!   (`Store::check_file`), such as an older copy put back. It opens only
//!   if the user says so. `p`: whether it has the same password settings;
//!   if not, it may be from before a password change. The first start that
//!   keeps a record has nothing to compare with, and records what's there.
//! - "Differs from copy": an older version changed the old copy since the
//!   move. The marker is updated to the copy as it is, so it's said once.
//! - After a move, the moved file is never quietly replaced by the older
//!   copy when it goes missing; the user chooses.

use serde_json::{json, Value};
use still_core::sodium;
use still_core::vault::time;

pub use crate::record::Moved;
use crate::record::{Converted, Record};
use crate::store::{AppStore, FileCheck, Loaded, Restore, Values};

/// The localStorage key versions up to 0.8 kept the moved marker under.
pub const MOVED_MARKER: &str = "still-moved-to-file";
/// The localStorage key versions up to 0.8 kept the conversion marker under.
pub const CONVERTED_MARKER: &str = "still-converted-v2";

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Startup {
    /// The vault file is ready (or there is none yet, on a new install).
    Ready {
        notice: Option<&'static str>,
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
    /// The vault file isn't the one Still saved last: an older copy put
    /// back, or a changed one. It opens only if the user says so.
    /// `same_password`: false if it may be from before a password change.
    Replaced {
        same_password: bool,
    },
    Failed,
}

impl Startup {
    /// What the page gets: {kind, notice?, movedAt?, ...}.
    pub fn to_json(&self) -> Value {
        match self {
            Self::Ready { notice } => {
                let mut ready = json!({ "kind": "ready" });
                if let Some(notice) = notice {
                    ready["notice"] = json!(notice);
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
            Self::Replaced { same_password } => {
                json!({ "kind": "replaced", "samePassword": same_password })
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
            key.starts_with("still-") && key != MOVED_MARKER && key != CONVERTED_MARKER
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

/// The moved marker as the page found it, read as earlier versions read it: a
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

/// The conversion marker as the page found it: one whose convertedAt is a
/// string (its fingerprint was informational, and may be missing).
fn read_converted(text: Option<&str>) -> Option<Converted> {
    let value: Value = serde_json::from_str(text?).ok()?;
    let object = value.as_object()?;
    Some(Converted {
        converted_at: object.get("convertedAt")?.as_str()?.to_owned(),
        fingerprint: object
            .get("fingerprint")
            .and_then(Value::as_str)
            .unwrap_or_default()
            .to_owned(),
    })
}

/// The record (record.rs), or, the first time there is none, one made from
/// the markers the page found in localStorage, and kept. If it can't be
/// written, the markers are taken again next time.
fn record_or_adopt(store: &AppStore, marker: Option<&str>, converted: Option<&str>) -> Record {
    let adopted = || Record {
        moved: read_marker(marker),
        converted: read_converted(converted),
        ..Record::default()
    };
    if store.already_open {
        return adopted();
    }
    let store = store.store();
    let record = store.record().unwrap_or_else(|| {
        let record = adopted();
        let _ = store.set_record(&record);
        record
    });
    // Nothing to compare the vault file with yet: trust what's there. (If
    // this can't be written, the next start tries again.)
    let _ = store.accept_file(true);
    record
}

/// The user's choice for a vault file that isn't the one Still saved last:
/// open it, making it the vault from now on.
pub fn accept_replaced(store: &AppStore) -> Startup {
    if store.already_open {
        return Startup::AlreadyOpen;
    }
    match store.store().accept_file(false) {
        Ok(()) => Startup::Ready { notice: None },
        Err(_) => Startup::Failed,
    }
}

/// Records a new moved marker, keeping the rest of the record. If it can't
/// be written, only the notice about a changed old copy is lost.
fn record_moved(store: &AppStore, moved: Moved) {
    let store = store.store();
    let mut record = store.record().unwrap_or_default();
    record.moved = Some(moved);
    let _ = store.set_record(&record);
}

/// What the vault file is, as start-up sees it.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum FileKind {
    Missing,
    Unreadable,
    V1,
    V2,
}

/// The moved marker, compared with the old copy as it is now.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum MovedMarker {
    Absent,
    Matches(Moved),
    /// An older version changed the old copy since the move.
    Differs(Moved),
}

/// Everything start-up decides on (the rows of the table above).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Inputs {
    pub already_open: bool,
    pub file: FileKind,
    /// The vault file isn't the one Still saved last: Some(same password).
    pub replaced: Option<bool>,
    /// `Store::restore_source` has something to put back.
    pub kept_copy: bool,
    pub moved: MovedMarker,
    /// When the conversion marker says the vault was converted to v2.
    pub converted_at: Option<String>,
    /// The old copy's values and their fingerprint.
    pub old_copy_empty: bool,
    pub old_copy_fingerprint: String,
}

/// What `decide` picks: an outcome to show, or one that writes first.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Decision {
    Show(Startup),
    /// Ready, saying once that the old copy changed: the marker is updated
    /// to this, the old copy as it is now.
    OldCopyChanged(Moved),
    MoveOldCopy,
}

/// The table above, in code; `open` and the table test both run it.
pub fn decide(inputs: &Inputs) -> Decision {
    use FileKind::*;
    let show = Decision::Show;
    let ready = || show(Startup::Ready { notice: None });
    if inputs.already_open {
        return show(Startup::AlreadyOpen);
    }
    match (inputs.file, &inputs.moved) {
        (Unreadable, _) => show(Startup::Unreadable {
            can_restore: inputs.kept_copy,
        }),
        (V1, _) if inputs.converted_at.is_some() => show(Startup::OldFormat {
            converted_at: inputs.converted_at.clone().unwrap_or_default(),
        }),
        (V1 | V2, _) if inputs.replaced.is_some() => show(Startup::Replaced {
            same_password: inputs.replaced.unwrap_or_default(),
        }),
        (V1 | V2, MovedMarker::Differs(marker)) => Decision::OldCopyChanged(Moved {
            fingerprint: inputs.old_copy_fingerprint.clone(),
            ..marker.clone()
        }),
        (V1 | V2, _) => ready(),
        (Missing, _) if inputs.kept_copy => show(Startup::Unreadable { can_restore: true }),
        (Missing, MovedMarker::Matches(marker) | MovedMarker::Differs(marker)) => {
            show(Startup::FileMissing {
                moved_at: marker.moved_at.clone(),
            })
        }
        (Missing, MovedMarker::Absent) if inputs.old_copy_empty => ready(),
        (Missing, MovedMarker::Absent) => Decision::MoveOldCopy,
    }
}

/// What's there now: the vault folder, its record, and the old copy.
fn gather(store: &AppStore, legacy: &Values, record: Record) -> Inputs {
    let old_copy_fingerprint = fingerprint(legacy);
    let moved = match record.moved {
        None => MovedMarker::Absent,
        Some(marker) if marker.fingerprint == old_copy_fingerprint => MovedMarker::Matches(marker),
        Some(marker) => MovedMarker::Differs(marker),
    };
    let (file, replaced, kept_copy) = if store.already_open {
        (FileKind::Missing, None, false)
    } else {
        let store = store.store();
        let file = match store.load() {
            Loaded::Nothing => FileKind::Missing,
            Loaded::Unreadable => FileKind::Unreadable,
            Loaded::Values(_) => FileKind::V1,
            Loaded::V2(_) => FileKind::V2,
        };
        let replaced = match store.check_file() {
            FileCheck::Replaced { same_password } => Some(same_password),
            FileCheck::Matches | FileCheck::Unrecorded => None,
        };
        (file, replaced, store.restore_source().is_some())
    };
    Inputs {
        already_open: store.already_open,
        file,
        replaced,
        kept_copy,
        moved,
        converted_at: record.converted.map(|c| c.converted_at),
        old_copy_empty: legacy.is_empty(),
        old_copy_fingerprint,
    }
}

pub fn open(
    store: &AppStore,
    legacy: Values,
    marker: Option<&str>,
    converted: Option<&str>,
    now_ms: i64,
) -> Startup {
    let legacy = legacy_values(legacy);
    let record = record_or_adopt(store, marker, converted);
    match decide(&gather(store, &legacy, record)) {
        Decision::Show(startup) => startup,
        Decision::OldCopyChanged(moved) => {
            record_moved(store, moved);
            Startup::Ready {
                notice: Some("old-copy-changed"),
            }
        }
        Decision::MoveOldCopy => move_old_copy(store, legacy, now_ms),
    }
}

/// Puts back the newest copy Still kept (a readable v2 backup, else the v1
/// file an upgrade kept) over a vault file that can't be opened, which is
/// kept too: nothing is deleted. Going back to the v1 file was the user's
/// choice, so the conversion marker goes (if that can't be written, the
/// next start asks before opening it).
pub fn restore_kept(store: &AppStore) -> Startup {
    if store.already_open {
        return Startup::AlreadyOpen;
    }
    let store = store.store();
    match store.restore() {
        Ok(source) => {
            if matches!(source, Restore::KeptV1(_)) {
                let mut record = store.record().unwrap_or_default();
                record.converted = None;
                let _ = store.set_record(&record);
            }
            Startup::Ready {
                notice: Some("restored"),
            }
        }
        Err(_) => Startup::Failed,
    }
}

/// Copies the old values into a new vault file, then records the marker.
/// Also the user's choice on the file-missing screen.
pub fn move_old_copy(store: &AppStore, legacy: Values, now_ms: i64) -> Startup {
    if store.already_open {
        return Startup::AlreadyOpen;
    }
    let values = legacy_values(legacy);
    if store.store().import_legacy(values.clone()).is_err() {
        return Startup::Failed;
    }
    record_moved(
        store,
        Moved {
            moved_at: time::to_iso(now_ms),
            fingerprint: fingerprint(&values),
        },
    );
    Startup::Ready {
        notice: Some("moved"),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::PathBuf;
    use std::sync::Arc;

    use still_core::session::SecretText;
    use still_core::vault::backend::Notice;

    use crate::vault::{FileStorage, Vault};

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

    fn record(store: &AppStore) -> Record {
        store.store().record().expect("a record")
    }

    /// The moved marker as recorded, as the text versions up to 0.8 kept
    /// in localStorage.
    fn marker_text(store: &AppStore) -> String {
        serde_json::to_string(&record(store).moved.unwrap()).unwrap()
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
            Startup::Ready { notice: None }
        );
        assert_eq!(stored(&store), None);
        assert_eq!(record(&store), Record::default());
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

        assert_eq!(
            started.to_json(),
            json!({ "kind": "ready", "notice": "moved" })
        );
        assert_eq!(stored(&store), Some(legacy.clone()));
        let marker = marker_text(&store);
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

    // Someone still on v0.1.x who installs this version does both upgrades in
    // one go: the move into the file at start-up, then the conversion to v2 at
    // the first unlock. Each has its own tests; this runs them back to back
    // through the real vault file, with the real keys.
    #[test]
    fn upgrades_a_v0_1_vault_in_one_go_moving_it_then_converting_it() {
        let tmp = TempDir::new();
        let store = Arc::new(tmp.store());
        let legacy = real_vault();
        let started = open(&store, legacy.clone(), None, None, NOW);
        assert_eq!(started.to_json()["notice"], "moved");

        let vault = Vault::new(FileStorage(store.clone()));
        let mut backend = vault.backend();
        let expected: Value =
            serde_json::from_str(include_str!("../../fixtures/vault-v1-real/expected.json"))
                .unwrap();
        let password = SecretText::from(expected["password"].as_str().unwrap().to_owned());
        backend.unlock(&password).unwrap();
        let Some(Notice::Upgraded { kept, .. }) = backend.take_notice() else {
            panic!("the moved vault is converted at its first unlock");
        };

        // The v1 file the move wrote is kept, and the vault file is now v2.
        let kept: Values =
            serde_json::from_slice(&std::fs::read(tmp.0.join("vault").join(&kept)).unwrap())
                .map(|file: Value| serde_json::from_value(file["data"].clone()).unwrap())
                .unwrap();
        assert_eq!(kept, legacy);
        assert!(matches!(store.store().load(), Loaded::V2(_)));
        // The store recorded the conversion, so a v1 copy put back asks first.
        let converted = record(&store).converted.unwrap();
        // (Of the file as converted; the unlock's Archive purge saved again.)
        assert_eq!(converted.fingerprint.len(), 64);
        assert_eq!(
            converted.converted_at.len(),
            "2026-10-05T10:00:00.000Z".len()
        );
        assert_eq!(
            open(&store, legacy.clone(), None, None, NOW).to_json(),
            json!({ "kind": "ready" })
        );

        // Every secret in the Lenses reads back exactly. (The Archive's entry
        // is older than 7 days by the system clock, so the unlock purged it.)
        let view = backend.view();
        for (lens_id, lens) in expected["lenses"].as_object().unwrap() {
            let shown = view.lenses.iter().find(|l| l["id"] == *lens_id).unwrap();
            assert_eq!(shown["name"], lens["name"]);
            for (item_id, value) in lens["items"].as_object().unwrap() {
                let revealed = backend.reveal_item(lens_id, item_id).unwrap();
                assert_eq!(revealed.expose(), value.as_str().unwrap());
            }
        }

        // And after a restart, it opens as v2 with nothing more to convert.
        drop(backend);
        let reopened = Vault::new(FileStorage(store));
        let mut backend = reopened.backend();
        backend.unlock(&password).unwrap();
        assert_eq!(backend.take_notice(), None);
        assert_eq!(backend.view().lenses.len(), view.lenses.len());
    }

    #[test]
    fn uses_the_file_not_the_old_copy_from_then_on() {
        let tmp = TempDir::new();
        let store = tmp.store();
        open(&store, real_vault(), None, None, NOW);
        let marker = marker_text(&store);
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
        open(&store, real_vault(), None, None, NOW);
        let marker = marker_text(&store);
        let changed = with(&real_vault(), &[("still-lenses", "[]")]);

        let started = open(&store, changed.clone(), Some(&marker), None, NOW + 1000);
        assert_eq!(started.to_json()["notice"], "old-copy-changed");
        // The marker keeps when the vault moved, with the copy as it is now.
        let updated = marker_text(&store);
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
        open(&store, real_vault(), None, None, NOW);
        let marker = marker_text(&store);
        drop(store);
        // The whole folder has gone, record and all: the marker the page
        // still has in localStorage is taken again.
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
        assert_eq!(store.store().record(), None);
        assert_eq!(stored(&store), None);
        assert_eq!(
            open(&store, real_vault(), None, None, NOW).to_json()["notice"],
            "moved"
        );
    }

    const CONVERTED: &str = r#"{"convertedAt":"2026-10-13T09:00:00.000Z","fingerprint":"ab"}"#;

    /// A vault folder as versions up to 0.8 left it: the moved v1 file, and
    /// no record. Returns the moved marker's text.
    fn moved_by_an_older_version(tmp: &TempDir) -> (AppStore, String) {
        let store = tmp.store();
        open(&store, real_vault(), None, None, NOW);
        let marker = marker_text(&store);
        std::fs::remove_file(tmp.0.join("vault").join(crate::record::FILE_NAME)).unwrap();
        (store, marker)
    }

    // After a conversion, a v1 file in the vault's place asks before it opens.
    #[test]
    fn asks_before_opening_an_old_format_vault_after_a_conversion() {
        let tmp = TempDir::new();
        let (store, marker) = moved_by_an_older_version(&tmp);
        let old_format = Startup::OldFormat {
            converted_at: "2026-10-13T09:00:00.000Z".into(),
        };
        assert_eq!(
            open(&store, real_vault(), Some(&marker), Some(CONVERTED), NOW),
            old_format
        );
        // The record has it now, whatever the page sends.
        assert_eq!(open(&store, real_vault(), None, None, NOW), old_format);

        // Without the conversion marker (or with one it can't read), as before.
        for converted in [None, Some("{oops"), Some(r#"{"convertedAt":1}"#)] {
            let tmp = TempDir::new();
            let (store, marker) = moved_by_an_older_version(&tmp);
            assert_eq!(
                open(&store, real_vault(), Some(&marker), converted, NOW).to_json(),
                json!({ "kind": "ready" })
            );
            assert_eq!(record(&store).converted, None);
        }
    }

    // The first start of this version takes both localStorage markers into
    // the record, exactly; later starts go by the record alone.
    #[test]
    fn takes_the_localstorage_markers_into_the_record_once() {
        let tmp = TempDir::new();
        let (store, marker) = moved_by_an_older_version(&tmp);
        let dir = tmp.0.join("vault");
        // An older version made the vault v2 (here, any v2 file) and set
        // the conversion marker.
        std::fs::rename(dir.join("vault.json"), dir.join("vault-v1.json")).unwrap();
        store.store().write_v2(&a_v2_file()).unwrap();

        assert_eq!(
            open(&store, real_vault(), Some(&marker), Some(CONVERTED), NOW),
            Startup::Ready { notice: None }
        );
        assert_eq!(
            record(&store),
            Record {
                moved: Some(Moved {
                    moved_at: "2026-10-05T10:00:00.000Z".into(),
                    fingerprint: fingerprint(&real_vault()),
                }),
                converted: Some(Converted {
                    converted_at: "2026-10-13T09:00:00.000Z".into(),
                    fingerprint: "ab".into(),
                }),
                // The first start trusts the vault file that's there.
                saved: Some(fingerprint_of(&tmp)),
                pending: None,
            }
        );
        let taken = record(&store);

        // A stale marker the page still has changes nothing now: a later
        // restore of the kept v1 file dropped the conversion, say.
        let mut forgotten = taken.clone();
        forgotten.converted = None;
        store.store().set_record(&forgotten).unwrap();
        open(&store, real_vault(), Some(&marker), Some(CONVERTED), NOW);
        assert_eq!(record(&store), forgotten);
        // Nor does a page with no markers at all.
        open(&store, real_vault(), None, None, NOW);
        assert_eq!(record(&store), forgotten);
    }

    /// The record's fingerprint of the vault file as it is now.
    fn fingerprint_of(tmp: &TempDir) -> crate::record::Saved {
        let store = tmp.store();
        assert!(
            store.already_open,
            "only to read: the test's store holds the lock"
        );
        drop(store);
        let bytes = std::fs::read(tmp.0.join("vault").join("vault.json")).unwrap();
        crate::store::fingerprint_vault(&bytes)
    }

    fn a_v2_file() -> still_core::v2::File {
        let body = still_core::v2::Body {
            lenses: "[]".into(),
            bin: "[]".into(),
        };
        still_core::v2::seal_file(
            &still_core::crypto::Key::random(),
            &still_core::crypto::Key::random(),
            still_core::v2::Kdf::new_sensitive(),
            &body,
            None,
        )
    }

    #[test]
    fn opens_a_v2_vault_as_usual_with_the_conversion_marker() {
        let tmp = TempDir::new();
        let store = tmp.store();
        store.store().write_v2(&a_v2_file()).unwrap();
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
            open(&store, real_vault(), None, Some(CONVERTED), NOW),
            Startup::Unreadable { can_restore: true }
        );
        assert!(record(&store).converted.is_some());
        assert_eq!(
            restore_kept(&store).to_json(),
            json!({ "kind": "ready", "notice": "restored" })
        );
        // Going back to the v1 file was the user's choice: it opens as it is.
        assert_eq!(record(&store).converted, None);
        assert_eq!(
            open(&store, real_vault(), None, Some(CONVERTED), NOW),
            Startup::Ready { notice: None }
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
        assert_eq!(restore_kept(&store), Startup::Failed);
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
        assert_eq!(restore_kept(&store), Startup::Failed);
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
        open(&store, real_vault(), None, None, NOW);
        let marker = marker_text(&store);
        let with_marker = with(&real_vault(), &[("still-converted-v2", CONVERTED)]);
        assert_eq!(
            open(&store, with_marker, Some(&marker), None, NOW).to_json(),
            json!({ "kind": "ready" })
        );
    }

    // No vault file at all, but the copy an upgrade kept: offer that (it is
    // newer than any localStorage copy), not the create screen.
    #[test]
    fn offers_the_kept_copy_when_the_vault_file_is_gone() {
        let tmp = TempDir::new();
        let store = tmp.store();
        open(&store, real_vault(), None, None, NOW);
        let marker = marker_text(&store);
        let dir = tmp.0.join("vault");
        std::fs::rename(dir.join("vault.json"), dir.join("vault-v1.json")).unwrap();
        for marker in [None, Some(marker.as_str())] {
            assert_eq!(
                open(&store, real_vault(), marker, None, NOW),
                Startup::Unreadable { can_restore: true }
            );
        }
        assert_eq!(
            restore_kept(&store),
            Startup::Ready {
                notice: Some("restored")
            }
        );
        assert_eq!(stored(&store), Some(real_vault()));
    }

    // The table in the module's doc, written out as data: every combination
    // of inputs gets the outcome of the first row that matches it.
    #[test]
    fn decides_every_combination_as_the_table_says() {
        use FileKind::*;
        #[derive(Clone, Copy, PartialEq)]
        enum M {
            Absent,
            Matches,
            Differs,
        }
        #[derive(Clone, Copy, PartialEq, Debug)]
        enum Out {
            AlreadyOpen,
            /// Can restore (the kept-copy column).
            Unreadable(bool),
            OldFormat,
            /// Same password.
            Replaced(bool),
            ReadyChanged,
            Ready,
            FileMissing,
            Move,
        }
        struct Case {
            already_open: bool,
            file: FileKind,
            replaced: Option<bool>,
            kept_copy: bool,
            moved: M,
            converted: bool,
            empty: bool,
        }
        const ANY: &[bool] = &[false, true];
        const NO: &[bool] = &[false];
        const YES: &[bool] = &[true];
        const ALL: &[FileKind] = &[Missing, Unreadable, V1, V2];
        const ANY_M: &[M] = &[M::Absent, M::Matches, M::Differs];
        const SET: &[M] = &[M::Matches, M::Differs];
        // Columns as in the doc: another copy open, vault.json, not the
        // saved one, kept copy, moved marker, converted marker, old copy
        // empty; then the outcome.
        type Row = (
            &'static [bool],
            &'static [FileKind],
            &'static [bool],
            &'static [bool],
            &'static [M],
            &'static [bool],
            &'static [bool],
            fn(&Case) -> Out,
        );
        #[rustfmt::skip]
        let table: [Row; 10] = [
            (YES, ALL,           ANY, ANY, ANY_M,          ANY, ANY, |_| Out::AlreadyOpen),
            (NO,  &[Unreadable], ANY, ANY, ANY_M,          ANY, ANY, |c| Out::Unreadable(c.kept_copy)),
            (NO,  &[V1],         ANY, ANY, ANY_M,          YES, ANY, |_| Out::OldFormat),
            (NO,  &[V1, V2],     YES, ANY, ANY_M,          ANY, ANY, |c| Out::Replaced(c.replaced == Some(true))),
            (NO,  &[V1, V2],     NO,  ANY, &[M::Differs],  ANY, ANY, |_| Out::ReadyChanged),
            (NO,  &[V1, V2],     NO,  ANY, ANY_M,          ANY, ANY, |_| Out::Ready),
            (NO,  &[Missing],    ANY, YES, ANY_M,          ANY, ANY, |_| Out::Unreadable(true)),
            (NO,  &[Missing],    ANY, NO,  SET,            ANY, ANY, |_| Out::FileMissing),
            (NO,  &[Missing],    ANY, NO,  &[M::Absent],   ANY, YES, |_| Out::Ready),
            (NO,  &[Missing],    ANY, NO,  &[M::Absent],   ANY, NO,  |_| Out::Move),
        ];
        let marker = Moved {
            moved_at: "t".into(),
            fingerprint: "f".into(),
        };

        let mut cases = Vec::new();
        for &already_open in ANY {
            for &file in ALL {
                for replaced in [None, Some(false), Some(true)] {
                    for &kept_copy in ANY {
                        for &moved in ANY_M {
                            for &converted in ANY {
                                for &empty in ANY {
                                    cases.push(Case {
                                        already_open,
                                        file,
                                        replaced,
                                        kept_copy,
                                        moved,
                                        converted,
                                        empty,
                                    });
                                }
                            }
                        }
                    }
                }
            }
        }
        assert_eq!(cases.len(), 2 * 4 * 3 * 2 * 3 * 2 * 2);

        for case in &cases {
            let row = table
                .iter()
                .find(|r| {
                    r.0.contains(&case.already_open)
                        && r.1.contains(&case.file)
                        && r.2.contains(&case.replaced.is_some())
                        && r.3.contains(&case.kept_copy)
                        && r.4.contains(&case.moved)
                        && r.5.contains(&case.converted)
                        && r.6.contains(&case.empty)
                })
                .expect("the table covers every combination");
            let inputs = Inputs {
                already_open: case.already_open,
                file: case.file,
                replaced: case.replaced,
                kept_copy: case.kept_copy,
                moved: match case.moved {
                    M::Absent => MovedMarker::Absent,
                    M::Matches => MovedMarker::Matches(marker.clone()),
                    M::Differs => MovedMarker::Differs(marker.clone()),
                },
                converted_at: case.converted.then(|| "c".to_owned()),
                old_copy_empty: case.empty,
                old_copy_fingerprint: "now".into(),
            };
            let got = match decide(&inputs) {
                Decision::MoveOldCopy => Out::Move,
                Decision::OldCopyChanged(updated) => {
                    assert_eq!(updated.moved_at, "t");
                    assert_eq!(updated.fingerprint, "now");
                    Out::ReadyChanged
                }
                Decision::Show(Startup::AlreadyOpen) => Out::AlreadyOpen,
                Decision::Show(Startup::Unreadable { can_restore }) => Out::Unreadable(can_restore),
                Decision::Show(Startup::OldFormat { converted_at }) => {
                    assert_eq!(converted_at, "c");
                    Out::OldFormat
                }
                Decision::Show(Startup::Replaced { same_password }) => Out::Replaced(same_password),
                Decision::Show(Startup::Ready { notice: None }) => Out::Ready,
                Decision::Show(Startup::FileMissing { moved_at }) => {
                    assert_eq!(moved_at, "t");
                    Out::FileMissing
                }
                other => panic!("not in the table: {other:?}"),
            };
            assert_eq!(got, (row.7)(case));
        }
    }

    // An older copy of the vault file put back (a single-file restore, a
    // sync tool) asks before it opens.
    #[test]
    fn warns_when_an_older_vault_file_is_put_back() {
        let tmp = TempDir::new();
        let store = tmp.store();
        let file = tmp.0.join("vault").join("vault.json");
        open(&store, Values::new(), None, None, NOW);
        store.store().write_v2(&a_v2_file()).unwrap();
        let older = std::fs::read(&file).unwrap();
        store.store().write_v2(&a_v2_file()).unwrap();
        std::fs::write(&file, older).unwrap();

        // Different keys each time, so a different password too.
        let replaced = Startup::Replaced {
            same_password: false,
        };
        assert_eq!(open(&store, Values::new(), None, None, NOW), replaced);
        // It asks every time, until the user chooses to open it.
        assert_eq!(open(&store, Values::new(), None, None, NOW), replaced);
        assert_eq!(accept_replaced(&store), Startup::Ready { notice: None });
        assert_eq!(
            open(&store, Values::new(), None, None, NOW),
            Startup::Ready { notice: None }
        );
    }
}
