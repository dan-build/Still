//! What Still records about its vault, outside the vault file: `state.json`
//! in the vault folder. No keys and no secrets, only dates and SHA-256
//! fingerprints. Versions up to 0.8 kept the two markers in the page's
//! localStorage; the first start with this file takes them from there once
//! (see startup.rs), and from then on only this file counts.
//!
//! The file is written like the vault file (atomically, 0600). One that is
//! missing, damaged or of an unknown version counts as missing.

use serde::{Deserialize, Serialize};
use serde_json::Value;

/// The file's name in the vault folder.
pub const FILE_NAME: &str = "state.json";
const FORMAT: &str = "still-state";
const FORMAT_VERSION: u64 = 1;

/// When the vault moved out of localStorage, and a fingerprint of what was
/// moved (to notice later changes by older versions).
#[derive(Serialize, Deserialize, Debug, Clone, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct Moved {
    pub moved_at: String,
    pub fingerprint: String,
}

/// When the vault was converted to format v2, and a fingerprint of the v2
/// file it was converted into (informational).
#[derive(Serialize, Deserialize, Debug, Clone, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct Converted {
    pub converted_at: String,
    pub fingerprint: String,
}

/// Bytes (a SHA-256, say) as lowercase hex.
pub fn hex(bytes: &[u8]) -> String {
    bytes.iter().map(|b| format!("{b:02x}")).collect()
}

#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct Record {
    pub moved: Option<Moved>,
    pub converted: Option<Converted>,
}

#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct RecordFile {
    format: String,
    format_version: u64,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    moved: Option<Moved>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    converted: Option<Converted>,
}

impl Record {
    /// The record in `bytes`, or None if it isn't one this version reads.
    pub fn parse(bytes: &[u8]) -> Option<Self> {
        let value: Value = serde_json::from_slice(bytes).ok()?;
        if value.get("format")? != FORMAT || value.get("formatVersion")? != FORMAT_VERSION {
            return None;
        }
        let file: RecordFile = serde_json::from_value(value).ok()?;
        Some(Self {
            moved: file.moved,
            converted: file.converted,
        })
    }

    pub fn to_bytes(&self) -> Vec<u8> {
        let file = RecordFile {
            format: FORMAT.into(),
            format_version: FORMAT_VERSION,
            moved: self.moved.clone(),
            converted: self.converted.clone(),
        };
        let mut bytes = serde_json::to_vec_pretty(&file).expect("a record serialises");
        bytes.push(b'\n');
        bytes
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn round_trips_and_reads_only_its_own_format() {
        let record = Record {
            moved: Some(Moved {
                moved_at: "2026-10-05T10:00:00.000Z".into(),
                fingerprint: "ab".into(),
            }),
            converted: Some(Converted {
                converted_at: "2026-10-13T09:00:00.000Z".into(),
                fingerprint: "cd".into(),
            }),
        };
        assert_eq!(Record::parse(&record.to_bytes()), Some(record));
        assert_eq!(
            Record::parse(&Record::default().to_bytes()),
            Some(Record::default())
        );
        assert_eq!(
            String::from_utf8(Record::default().to_bytes()).unwrap(),
            "{\n  \"format\": \"still-state\",\n  \"formatVersion\": 1\n}\n"
        );
        for other in [
            "",
            "{oops",
            "[]",
            r#"{"format":"still-state"}"#,
            r#"{"format":"still-vault","formatVersion":1}"#,
            r#"{"format":"still-state","formatVersion":2}"#,
            r#"{"format":"still-state","formatVersion":1,"moved":{"movedAt":1}}"#,
        ] {
            assert_eq!(Record::parse(other.as_bytes()), None, "{other}");
        }
    }
}
