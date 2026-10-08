//! The stored Lens lists as JSON, kept exactly as JavaScript reads and
//! writes them. The app wrote them with `JSON.stringify`; reading and writing
//! them here must give the same text `JSON.stringify(JSON.parse(raw))` would.
//!
//! serde_json (with `preserve_order`) writes strings, key order, duplicate
//! keys and nesting as JavaScript does, with three exceptions, so a list
//! containing any of them is refused as unreadable instead of being written
//! back differently:
//! - numbers JavaScript would print another way (`1.0`, `1e2`, `-0`, `1e-7`,
//!   integers beyond 2^53);
//! - object keys that are array indexes (`"0"`, `"10"`), which JavaScript
//!   moves to the front;
//! - lone UTF-16 surrogates (`"\ud800"`) and nesting 128 deep, which
//!   serde_json can't read at all.
//!
//! None of these occur in a list the app wrote.

use serde_json::Value;

/// A stored list that can't be used: not JSON, not a list, or JSON that
/// couldn't be written back exactly.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct UnreadableList;

impl std::fmt::Display for UnreadableList {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str("stored Lens list is unreadable")
    }
}

impl std::error::Error for UnreadableList {}

/// Parses a stored Lens list. A missing value is an empty list.
pub fn parse_list(raw: Option<&str>) -> Result<Vec<Value>, UnreadableList> {
    let Some(raw) = raw else {
        return Ok(Vec::new());
    };
    match serde_json::from_str(raw) {
        Ok(Value::Array(list)) if list.iter().all(writes_as_javascript) => Ok(list),
        _ => Err(UnreadableList),
    }
}

/// `JSON.stringify` of a list read by `parse_list` (plus Lenses and items
/// built from strings, integers and the values it read).
pub fn write_list(list: &[Value]) -> String {
    serde_json::to_string(list).expect("JSON values always serialise")
}

/// Whether serde_json writes this value exactly as `JSON.stringify` would.
fn writes_as_javascript(value: &Value) -> bool {
    match value {
        Value::Null | Value::Bool(_) | Value::String(_) => true,
        Value::Number(n) => number_writes_as_javascript(n),
        Value::Array(items) => items.iter().all(writes_as_javascript),
        Value::Object(map) => map
            .iter()
            .all(|(key, v)| !is_array_index(key) && writes_as_javascript(v)),
    }
}

/// Integers JavaScript holds exactly, and fractions printed without an
/// exponent: for those, serde_json and JavaScript both print the shortest
/// digits that read back to the same number, in plain decimal notation.
fn number_writes_as_javascript(n: &serde_json::Number) -> bool {
    const SAFE: u64 = (1 << 53) - 1;
    if let Some(i) = n.as_i64() {
        return i.unsigned_abs() <= SAFE;
    }
    if let Some(u) = n.as_u64() {
        return u <= SAFE;
    }
    let Some(f) = n.as_f64() else {
        return false;
    };
    let text = n.to_string();
    f.is_finite() && f.fract() != 0.0 && !text.contains(['e', 'E']) && f.abs() >= 1e-6
}

/// A canonical array index ("0" to "4294967294"), which JavaScript lists
/// before every other key of an object.
fn is_array_index(key: &str) -> bool {
    let canonical = key == "0" || (!key.starts_with('0') && !key.is_empty());
    canonical
        && key.len() <= 10
        && key.bytes().all(|b| b.is_ascii_digit())
        && key.parse::<u64>().is_ok_and(|n| n < 4_294_967_295)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn round_trip(raw: &str) -> Result<String, UnreadableList> {
        parse_list(Some(raw)).map(|list| write_list(&list))
    }

    #[test]
    fn treats_a_missing_list_as_empty() {
        assert_eq!(parse_list(None), Ok(vec![]));
    }

    #[test]
    fn refuses_what_is_not_a_json_list() {
        for raw in [
            "",
            "{not json",
            r#"{"id":"x"}"#,
            "null",
            "[1,]",
            "[1][2]",
            "\u{FEFF}[]",
        ] {
            assert_eq!(parse_list(Some(raw)), Err(UnreadableList), "{raw}");
        }
    }

    // Each expected output is what Node printed for JSON.stringify(JSON.parse(raw)).
    #[test]
    fn writes_back_exactly_what_javascript_would() {
        for (raw, js) in [
            (r#"[{"b":1,"a":2}]"#, r#"[{"b":1,"a":2}]"#),
            (r#"[{"a":1,"b":2,"a":3}]"#, r#"[{"a":3,"b":2}]"#),
            (" [ { \"a\" : [ 1 , 2 ] } ]\n", r#"[{"a":[1,2]}]"#),
            (r#"["\"","\\","\/","/"]"#, r#"["\"","\\","/","/"]"#),
            (
                r#"["\u0000\u0001\b\t\n\u000b\f\r\u001f"]"#,
                r#"["\u0000\u0001\b\t\n\u000b\f\r\u001f"]"#,
            ),
            (
                "[\"\u{7f}\u{2028}\u{2029}é🔐\"]",
                "[\"\u{7f}\u{2028}\u{2029}é🔐\"]",
            ),
            (r#"["\u00e9\ud83d\udd10"]"#, "[\"é🔐\"]"),
            (
                r#"[0,1,-3,2.5,0.1,0.000025,9007199254740991]"#,
                r#"[0,1,-3,2.5,0.1,0.000025,9007199254740991]"#,
            ),
            (
                r#"[{},[],null,true,false,""]"#,
                r#"[{},[],null,true,false,""]"#,
            ),
            (
                r#"[{"01":1,"-1":2,"1.5":3,"4294967295":4}]"#,
                r#"[{"01":1,"-1":2,"1.5":3,"4294967295":4}]"#,
            ),
            (r#"[{"__proto__":1}]"#, r#"[{"__proto__":1}]"#),
            ("[1.50e0,2.5E0]", "[1.5,2.5]"),
            // Without serde_json's float_roundtrip, these read one step off and print differently.
            (
                "[9.268236430052177,-16196325088.589525,-0.05605412907488959]",
                "[9.268236430052177,-16196325088.589525,-0.05605412907488959]",
            ),
        ] {
            assert_eq!(round_trip(raw).as_deref(), Ok(js), "{raw}");
        }
    }

    // JavaScript would write each of these differently from serde_json.
    #[test]
    fn refuses_what_it_could_not_write_back_exactly() {
        for raw in [
            "[1.0]",
            "[1e2]",
            "[-0]",
            "[-0.0]",
            "[1e20]",
            "[1e21]",
            "[0.000001]",
            "[1e-7]",
            "[12345678901234567890]",
            "[9007199254740993]",
            "[-9007199254740993]",
            "[1e400]",
            r#"[{"b":1,"0":2}]"#,
            r#"[{"4294967294":1}]"#,
            r#"[{"x":{"10":1}}]"#,
            r#"["\ud800"]"#,
            r#"["\udc00\ud800"]"#,
        ] {
            assert_eq!(parse_list(Some(raw)), Err(UnreadableList), "{raw}");
        }
        let deep = format!("{}{}", "[".repeat(129), "]".repeat(129));
        assert_eq!(parse_list(Some(&deep)), Err(UnreadableList));
    }

    #[test]
    fn round_trips_every_golden_list_byte_for_byte() {
        for fixture in ["vault-v1", "vault-v1-real", "vault-v1-rust"] {
            let path = format!(
                "{}/../../fixtures/{fixture}/vault.json",
                env!("CARGO_MANIFEST_DIR")
            );
            let vault: Value =
                serde_json::from_str(&std::fs::read_to_string(path).unwrap()).unwrap();
            for key in ["still-lenses", "still-recycle-bin"] {
                let raw = vault[key].as_str().unwrap();
                assert_eq!(round_trip(raw).as_deref(), Ok(raw), "{fixture} {key}");
            }
        }
    }
}
