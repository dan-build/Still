//! Pure operations on the stored vault lists. No crypto, no storage, no keys:
//! Lenses stay exactly as stored (including their wrapped key), so saving an
//! unchanged vault writes back the same bytes and unreadable Lenses survive.
//!
//! Lenses and items are kept as JSON values, so fields this code doesn't know
//! about, and the order of every field, survive each change. Changing a field
//! keeps its place; a new field goes last, as with JavaScript's `{...lens, field}`.

use serde_json::{Map, Value};

use super::time;

pub const RECYCLE_DAYS: i64 = 7;
const DAY_MS: i64 = 24 * 60 * 60 * 1000;

/// The Lenses and the recycle bin ("Archive"), exactly as stored.
#[derive(Debug, Clone, Default, PartialEq)]
pub struct Lists {
    pub lenses: Vec<Value>,
    pub bin: Vec<Value>,
}

/// The lists a change produced: `None` for a list it left as it was.
#[derive(Debug, Clone, Default, PartialEq)]
pub struct Change {
    pub lenses: Option<Vec<Value>>,
    pub bin: Option<Vec<Value>>,
}

impl Change {
    pub fn is_empty(&self) -> bool {
        self.lenses.is_none() && self.bin.is_none()
    }
}

/// A Lens's (or an item's) id, if it is a string.
pub fn id_of(value: &Value) -> Option<&str> {
    value.get("id")?.as_str()
}

fn has_id(value: &Value, id: &str) -> bool {
    id_of(value) == Some(id)
}

/// `{...value, key: field}`: an existing key keeps its place, a new one goes last.
fn with_field(value: &Value, key: &str, field: Value) -> Value {
    let mut map = value.as_object().cloned().unwrap_or_default();
    map.insert(key.to_owned(), field);
    Value::Object(map)
}

/// JavaScript's `String.prototype.trim`.
pub fn js_trim(text: &str) -> &str {
    text.trim_matches(crate::crypto::is_js_whitespace)
}

pub fn add_lens(lists: &Lists, lens: Value) -> Change {
    let mut lenses = Vec::with_capacity(lists.lenses.len() + 1);
    lenses.push(lens);
    lenses.extend(lists.lenses.iter().cloned());
    Change {
        lenses: Some(lenses),
        bin: None,
    }
}

/// Renames a Lens (trimmed); everything else stays exactly as stored.
pub fn rename_lens(lists: &Lists, lens_id: &str, name: &str) -> Change {
    let name = Value::String(js_trim(name).to_owned());
    let lenses = lists
        .lenses
        .iter()
        .map(|lens| {
            if has_id(lens, lens_id) {
                with_field(lens, "name", name.clone())
            } else {
                lens.clone()
            }
        })
        .collect();
    Change {
        lenses: Some(lenses),
        bin: None,
    }
}

/// Replaces a Lens's items and keeps its itemCount in step.
pub fn set_items(lists: &Lists, lens_id: &str, items: Vec<Value>) -> Change {
    let count = Value::from(items.len());
    let items = Value::Array(items);
    let lenses = lists
        .lenses
        .iter()
        .map(|lens| {
            if has_id(lens, lens_id) {
                with_field(
                    &with_field(lens, "items", items.clone()),
                    "itemCount",
                    count.clone(),
                )
            } else {
                lens.clone()
            }
        })
        .collect();
    Change {
        lenses: Some(lenses),
        bin: None,
    }
}

/// Moves a Lens to the front of the bin, with the time it was deleted.
pub fn forget_lens(lists: &Lists, lens_id: &str, now_ms: i64) -> Change {
    let Some(lens) = lists.lenses.iter().find(|l| has_id(l, lens_id)) else {
        return Change::default();
    };
    let forgotten = with_field(lens, "deletedAt", Value::String(time::to_iso(now_ms)));
    // A stale bin copy left by v0.1.0 (see restore_lens) is replaced, not duplicated.
    let bin = std::iter::once(forgotten)
        .chain(lists.bin.iter().filter(|l| !has_id(l, lens_id)).cloned())
        .collect();
    Change {
        lenses: Some(without(&lists.lenses, lens_id)),
        bin: Some(bin),
    }
}

/// Moves a Lens from the bin back to the front of the list. v0.1.0 could leave
/// a forgotten Lens in both lists; the bin copy is the newer one (forgetting
/// moved the Lens's latest items there), so it replaces the stale copy.
pub fn restore_lens(lists: &Lists, lens_id: &str) -> Change {
    let Some(recycled) = lists.bin.iter().find(|l| has_id(l, lens_id)) else {
        return Change::default();
    };
    let mut map: Map<String, Value> = recycled.as_object().cloned().unwrap_or_default();
    // shift_remove keeps the other fields in order (plain remove would not).
    map.shift_remove("deletedAt");
    let lenses = std::iter::once(Value::Object(map))
        .chain(lists.lenses.iter().filter(|l| !has_id(l, lens_id)).cloned())
        .collect();
    Change {
        lenses: Some(lenses),
        bin: Some(without(&lists.bin, lens_id)),
    }
}

pub fn delete_lens_forever(lists: &Lists, lens_id: &str) -> Change {
    Change {
        lenses: None,
        bin: Some(without(&lists.bin, lens_id)),
    }
}

/// Removes bin entries deleted more than RECYCLE_DAYS ago (same rule as
/// v0.1.0): an entry is kept only if its `deletedAt` is a valid time after
/// the cutoff, so one without a valid `deletedAt` counts as expired. (A
/// null entry, which made JavaScript throw, never gets here: the backend
/// refuses to unlock with one.)
pub fn purge_expired(bin: &[Value], now_ms: i64) -> Vec<Value> {
    let cutoff = now_ms - RECYCLE_DAYS * DAY_MS;
    bin.iter()
        .filter(|lens| {
            // JavaScript reads `new Date(lens.deletedAt ?? '')`: null counts as missing.
            let deleted_at = lens.get("deletedAt").filter(|v| !v.is_null());
            time::js_date_value(deleted_at).is_some_and(|ms| ms > cutoff)
        })
        .cloned()
        .collect()
}

fn without(list: &[Value], lens_id: &str) -> Vec<Value> {
    list.iter()
        .filter(|l| !has_id(l, lens_id))
        .cloned()
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    const NOW: i64 = 1_790_596_800_000; // 2026-09-28T12:00:00.000Z

    fn days_ago(days: f64) -> String {
        time::to_iso(NOW - (days * DAY_MS as f64) as i64)
    }

    fn lens(id: &str) -> Value {
        json!({
            "id": id,
            "name": format!("Lens {id}"),
            "createdAt": "2026-01-01T00:00:00.000Z",
            "itemCount": 0,
            "encryptedMasterKey": format!("wrapped-{id}"),
            "items": [],
        })
    }

    fn lens_with(id: &str, key: &str, value: Value) -> Value {
        with_field(&lens(id), key, value)
    }

    fn ids(list: &[Value]) -> Vec<&str> {
        list.iter().filter_map(id_of).collect()
    }

    fn base() -> Lists {
        Lists {
            lenses: vec![lens("a"), lens("b")],
            bin: vec![lens_with("z", "deletedAt", json!(days_ago(1.0)))],
        }
    }

    #[test]
    fn adds_a_new_lens_first() {
        let change = add_lens(&base(), lens("new"));
        assert_eq!(ids(&change.lenses.unwrap()), ["new", "a", "b"]);
        assert_eq!(change.bin, None);
    }

    #[test]
    fn renames_a_lens_trimmed_leaving_everything_else_as_stored() {
        let lenses = rename_lens(&base(), "b", "  Banking  ").lenses.unwrap();
        assert_eq!(lenses[1], lens_with("b", "name", json!("Banking")));
        assert_eq!(lenses[0], lens("a"));
        // JavaScript's trim, not Rust's: U+FEFF is trimmed, U+0085 is not.
        let lenses = rename_lens(&base(), "a", "\u{FEFF}\u{3000}x\u{0085}")
            .lenses
            .unwrap();
        assert_eq!(lenses[0]["name"], "x\u{0085}");
    }

    #[test]
    fn sets_items_and_keeps_item_count_in_step() {
        let items =
            vec![json!({"id": "i1", "label": "L", "type": "password", "encryptedValue": "blob"})];
        let lenses = set_items(&base(), "b", items.clone()).lenses.unwrap();
        assert_eq!(lenses[1]["items"], Value::Array(items));
        assert_eq!(lenses[1]["itemCount"], 1);
        assert_eq!(lenses[0], lens("a"));
    }

    #[test]
    fn keeps_field_order_and_unknown_fields() {
        let odd = json!({"items": [], "zeta": {"deep": [1, null]}, "id": "o", "itemCount": 5});
        let lists = Lists {
            lenses: vec![odd],
            bin: vec![],
        };
        let lenses = set_items(&lists, "o", vec![]).lenses.unwrap();
        assert_eq!(
            serde_json::to_string(&lenses).unwrap(),
            r#"[{"items":[],"zeta":{"deep":[1,null]},"id":"o","itemCount":0}]"#
        );
        // A Lens stored without items gets them last.
        let bare = Lists {
            lenses: vec![json!({"id": "b", "name": "B"})],
            bin: vec![],
        };
        let lenses = set_items(&bare, "b", vec![]).lenses.unwrap();
        assert_eq!(
            serde_json::to_string(&lenses).unwrap(),
            r#"[{"id":"b","name":"B","items":[],"itemCount":0}]"#
        );
    }

    #[test]
    fn forgets_a_lens_into_the_front_of_the_bin_with_a_deleted_at_time() {
        let change = forget_lens(&base(), "a", NOW);
        assert_eq!(ids(change.lenses.as_ref().unwrap()), ["b"]);
        let bin = change.bin.unwrap();
        assert_eq!(ids(&bin), ["a", "z"]);
        assert_eq!(bin[0]["deletedAt"], "2026-09-28T12:00:00.000Z");
    }

    #[test]
    fn restores_a_lens_to_the_front_of_the_list_without_deleted_at() {
        let change = restore_lens(&base(), "z");
        let lenses = change.lenses.unwrap();
        assert_eq!(ids(&lenses), ["z", "a", "b"]);
        assert_eq!(lenses[0], lens("z"));
        assert_eq!(change.bin, Some(vec![]));
    }

    #[test]
    fn restoring_a_lens_left_in_both_lists_replaces_the_stale_copy() {
        let stale = lens_with("dup", "name", json!("Stale copy"));
        let newer = with_field(
            &lens_with("dup", "name", json!("Newer copy")),
            "deletedAt",
            json!(days_ago(1.0)),
        );
        let lists = Lists {
            lenses: vec![lens("a"), stale],
            bin: vec![newer],
        };
        let change = restore_lens(&lists, "dup");
        let names: Vec<_> = change
            .lenses
            .unwrap()
            .iter()
            .map(|l| l["name"].clone())
            .collect();
        assert_eq!(names, [json!("Newer copy"), json!("Lens a")]);
        assert_eq!(change.bin, Some(vec![]));
    }

    #[test]
    fn forgetting_a_lens_left_in_both_lists_replaces_the_stale_bin_copy() {
        let lists = Lists {
            lenses: vec![lens("dup"), lens("a")],
            bin: vec![lens_with("dup", "deletedAt", json!(days_ago(3.0)))],
        };
        let change = forget_lens(&lists, "dup", NOW);
        let bin = change.bin.unwrap();
        assert_eq!(ids(&bin), ["dup"]);
        assert_eq!(bin[0]["deletedAt"], time::to_iso(NOW));
        assert_eq!(ids(&change.lenses.unwrap()), ["a"]);
    }

    #[test]
    fn deletes_a_bin_entry_for_good() {
        assert_eq!(delete_lens_forever(&base(), "z").bin, Some(vec![]));
    }

    #[test]
    fn ignores_unknown_ids() {
        assert!(forget_lens(&base(), "nope", NOW).is_empty());
        assert!(restore_lens(&base(), "nope").is_empty());
        // As in JavaScript, these still produce a (same) list, so they write.
        assert_eq!(
            rename_lens(&base(), "nope", "X").lenses,
            Some(base().lenses)
        );
        assert_eq!(delete_lens_forever(&base(), "nope").bin, Some(base().bin));
    }

    #[test]
    fn matches_only_string_ids() {
        let lists = Lists {
            lenses: vec![json!({"id": 1, "name": "Number id"})],
            bin: vec![],
        };
        assert!(forget_lens(&lists, "1", NOW).is_empty());
        assert_eq!(
            rename_lens(&lists, "1", "X").lenses,
            Some(lists.lenses.clone())
        );
    }

    #[test]
    fn restoring_keeps_the_other_fields_in_order() {
        let recycled =
            json!({"id": "r", "deletedAt": "2026-09-27T00:00:00.000Z", "name": "R", "items": []});
        let lists = Lists {
            lenses: vec![],
            bin: vec![recycled],
        };
        let lenses = restore_lens(&lists, "r").lenses.unwrap();
        assert_eq!(
            serde_json::to_string(&lenses).unwrap(),
            r#"[{"id":"r","name":"R","items":[]}]"#
        );
    }

    #[test]
    fn keeps_entries_deleted_within_7_days_and_removes_older_ones() {
        let bin = [
            lens_with("recent", "deletedAt", json!(days_ago(6.9))),
            lens_with("old", "deletedAt", json!(days_ago(7.1))),
            lens_with("edge", "deletedAt", json!(days_ago(7.0))),
        ];
        assert_eq!(ids(&purge_expired(&bin, NOW)), ["recent"]);
    }

    // Same rule as v0.1.0: an entry without a valid deletedAt counts as expired.
    #[test]
    fn removes_bin_entries_without_a_valid_deleted_at() {
        let bin = [
            lens("none"),
            lens_with("bad", "deletedAt", json!("not a date")),
            lens_with("null", "deletedAt", Value::Null),
            json!(1),
            lens_with("future", "deletedAt", json!("2027-01-01T00:00:00.000Z")),
            lens_with("empty", "deletedAt", json!("")),
            lens_with("number-old", "deletedAt", json!(NOW - 8 * DAY_MS)),
            lens_with("number-new", "deletedAt", json!(NOW - DAY_MS)),
        ];
        assert_eq!(ids(&purge_expired(&bin, NOW)), ["future", "number-new"]);
    }

    #[test]
    fn counts_a_time_zone_offset_at_the_cutoff() {
        // 7 days ago at 12:00Z is 14:00+02:00; a minute either side decides.
        let bin = [
            lens_with(
                "before",
                "deletedAt",
                json!("2026-09-21T13:59:00.000+02:00"),
            ),
            lens_with("after", "deletedAt", json!("2026-09-21T14:01:00.000+02:00")),
        ];
        assert_eq!(ids(&purge_expired(&bin, NOW)), ["after"]);
    }
}
