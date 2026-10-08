//! The v1 stored format: parse and write blobs exactly as the original
//! crypto.ts laid them out. Pure and total: malformed
//! input is an error, never a panic.
//!
//! - Key blob (master key or Lens key), 73 bytes:
//!   `[version 1][nonce 24][ciphertext 32 + tag 16]`
//! - Item blob, 45 bytes or more:
//!   `[version 1][subkey id, u32 little-endian][nonce 24][ciphertext + tag 16]`
//! - Salt: 16 bytes.
//!
//! All stored as standard, padded base64.

use crate::sodium::{from_base64, to_base64};

pub const VERSION: u8 = 1;
pub const NONCE_BYTES: usize = 24;
pub const TAG_BYTES: usize = 16;
pub const KEY_BYTES: usize = 32;
pub const SALT_BYTES: usize = 16;
pub const KEY_BLOB_BYTES: usize = 1 + NONCE_BYTES + KEY_BYTES + TAG_BYTES;
pub const ITEM_BLOB_MIN_BYTES: usize = 1 + 4 + NONCE_BYTES + TAG_BYTES;

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum FormatError {
    /// Not standard, padded base64.
    NotBase64,
    /// A version this code doesn't know.
    UnsupportedVersion(u8),
    /// The wrong number of bytes for this kind of blob.
    WrongLength { expected: usize, actual: usize },
    /// Fewer bytes than this kind of blob needs.
    TooShort { minimum: usize, actual: usize },
}

impl std::fmt::Display for FormatError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::NotBase64 => write!(f, "not standard padded base64"),
            Self::UnsupportedVersion(v) => write!(f, "unsupported format version {v}"),
            Self::WrongLength { expected, actual } => {
                write!(f, "expected {expected} bytes, got {actual}")
            }
            Self::TooShort { minimum, actual } => {
                write!(f, "expected at least {minimum} bytes, got {actual}")
            }
        }
    }
}

impl std::error::Error for FormatError {}

/// A wrapped 32-byte key: the master key (wrapped by the password key) or a
/// Lens key (wrapped by the master key).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct KeyBlob {
    pub nonce: [u8; NONCE_BYTES],
    /// The encrypted key followed by the tag.
    pub sealed: [u8; KEY_BYTES + TAG_BYTES],
}

/// An encrypted item value.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ItemBlob {
    pub subkey_id: u32,
    pub nonce: [u8; NONCE_BYTES],
    /// The encrypted value followed by the tag (at least 16 bytes).
    pub sealed: Vec<u8>,
}

fn decode_versioned(b64: &str) -> Result<Vec<u8>, FormatError> {
    let bytes = from_base64(b64).ok_or(FormatError::NotBase64)?;
    match bytes.first() {
        None => Err(FormatError::TooShort {
            minimum: 1,
            actual: 0,
        }),
        Some(&VERSION) => Ok(bytes),
        Some(&other) => Err(FormatError::UnsupportedVersion(other)),
    }
}

pub fn parse_key_blob(b64: &str) -> Result<KeyBlob, FormatError> {
    let bytes = decode_versioned(b64)?;
    if bytes.len() != KEY_BLOB_BYTES {
        return Err(FormatError::WrongLength {
            expected: KEY_BLOB_BYTES,
            actual: bytes.len(),
        });
    }
    let mut blob = KeyBlob {
        nonce: [0; NONCE_BYTES],
        sealed: [0; KEY_BYTES + TAG_BYTES],
    };
    blob.nonce.copy_from_slice(&bytes[1..1 + NONCE_BYTES]);
    blob.sealed.copy_from_slice(&bytes[1 + NONCE_BYTES..]);
    Ok(blob)
}

pub fn encode_key_blob(blob: &KeyBlob) -> String {
    let mut bytes = Vec::with_capacity(KEY_BLOB_BYTES);
    bytes.push(VERSION);
    bytes.extend_from_slice(&blob.nonce);
    bytes.extend_from_slice(&blob.sealed);
    to_base64(&bytes)
}

pub fn parse_item_blob(b64: &str) -> Result<ItemBlob, FormatError> {
    let bytes = decode_versioned(b64)?;
    if bytes.len() < ITEM_BLOB_MIN_BYTES {
        return Err(FormatError::TooShort {
            minimum: ITEM_BLOB_MIN_BYTES,
            actual: bytes.len(),
        });
    }
    let subkey_id = u32::from_le_bytes([bytes[1], bytes[2], bytes[3], bytes[4]]);
    let mut nonce = [0; NONCE_BYTES];
    nonce.copy_from_slice(&bytes[5..5 + NONCE_BYTES]);
    Ok(ItemBlob {
        subkey_id,
        nonce,
        sealed: bytes[5 + NONCE_BYTES..].to_vec(),
    })
}

pub fn encode_item_blob(blob: &ItemBlob) -> String {
    let mut bytes = Vec::with_capacity(5 + NONCE_BYTES + blob.sealed.len());
    bytes.push(VERSION);
    bytes.extend_from_slice(&blob.subkey_id.to_le_bytes());
    bytes.extend_from_slice(&blob.nonce);
    bytes.extend_from_slice(&blob.sealed);
    to_base64(&bytes)
}

pub fn parse_salt(b64: &str) -> Result<[u8; SALT_BYTES], FormatError> {
    let bytes = from_base64(b64).ok_or(FormatError::NotBase64)?;
    <[u8; SALT_BYTES]>::try_from(bytes.as_slice()).map_err(|_| FormatError::WrongLength {
        expected: SALT_BYTES,
        actual: bytes.len(),
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::Value;

    fn fixture(path: &str) -> Value {
        let file = format!("{}/../../fixtures/{path}", env!("CARGO_MANIFEST_DIR"));
        serde_json::from_str(&std::fs::read_to_string(&file).expect("fixture exists"))
            .expect("valid JSON")
    }

    /// Every stored blob in both committed vaults, as (kind, base64).
    fn fixture_blobs() -> Vec<(&'static str, String)> {
        let mut blobs = vec![];
        for dir in ["vault-v1", "vault-v1-real", "vault-v1-rust"] {
            let vault = fixture(&format!("{dir}/vault.json"));
            blobs.push((
                "key",
                vault["still-encrypted-master-key"]
                    .as_str()
                    .unwrap()
                    .to_string(),
            ));
            blobs.push(("salt", vault["still-salt"].as_str().unwrap().to_string()));
            for list in ["still-lenses", "still-recycle-bin"] {
                let lenses: Value = serde_json::from_str(vault[list].as_str().unwrap()).unwrap();
                for lens in lenses.as_array().unwrap() {
                    blobs.push((
                        "key",
                        lens["encryptedMasterKey"].as_str().unwrap().to_string(),
                    ));
                    for item in lens["items"].as_array().unwrap() {
                        blobs.push(("item", item["encryptedValue"].as_str().unwrap().to_string()));
                    }
                }
            }
        }
        let vectors = fixture("vault-v1/vectors.json");
        blobs.push((
            "key",
            vectors["masterKeyBlob"]["blob"]
                .as_str()
                .unwrap()
                .to_string(),
        ));
        blobs.push((
            "key",
            vectors["lensKeyBlob"]["blob"].as_str().unwrap().to_string(),
        ));
        for item in vectors["items"]["vectors"].as_array().unwrap() {
            blobs.push(("item", item["blob"].as_str().unwrap().to_string()));
        }
        blobs
    }

    #[test]
    fn parses_and_rewrites_every_fixture_blob_byte_for_byte() {
        let blobs = fixture_blobs();
        assert!(blobs.len() > 20);
        for (kind, b64) in blobs {
            let rewritten = match kind {
                "key" => encode_key_blob(&parse_key_blob(&b64).unwrap()),
                "item" => encode_item_blob(&parse_item_blob(&b64).unwrap()),
                _ => to_base64(&parse_salt(&b64).unwrap()),
            };
            assert_eq!(rewritten, b64, "{kind}");
        }
    }

    #[test]
    fn reads_the_subkey_id_as_little_endian() {
        let vectors = fixture("vault-v1/vectors.json");
        for item in vectors["items"]["vectors"].as_array().unwrap() {
            let blob = parse_item_blob(item["blob"].as_str().unwrap()).unwrap();
            assert_eq!(
                u64::from(blob.subkey_id),
                item["subkeyId"].as_u64().unwrap()
            );
        }
    }

    #[test]
    fn rejects_malformed_blobs() {
        let key = |bytes: &[u8]| to_base64(bytes);
        let mut good_key = vec![1u8];
        good_key.extend_from_slice(&[0; 72]);
        assert!(parse_key_blob(&key(&good_key)).is_ok());

        let mut v2 = good_key.clone();
        v2[0] = 2;
        assert_eq!(
            parse_key_blob(&key(&v2)),
            Err(FormatError::UnsupportedVersion(2))
        );
        assert_eq!(
            parse_key_blob(&key(&good_key[..72])),
            Err(FormatError::WrongLength {
                expected: 73,
                actual: 72
            })
        );
        assert_eq!(
            parse_key_blob(&key(&[good_key.clone(), vec![0]].concat())),
            Err(FormatError::WrongLength {
                expected: 73,
                actual: 74
            })
        );
        assert_eq!(
            parse_key_blob(""),
            Err(FormatError::TooShort {
                minimum: 1,
                actual: 0
            })
        );
        assert_eq!(parse_key_blob("not base64!"), Err(FormatError::NotBase64));

        assert_eq!(
            parse_item_blob(&key(&good_key[..44])),
            Err(FormatError::TooShort {
                minimum: 45,
                actual: 44
            })
        );
        assert!(parse_item_blob(&key(&good_key[..45])).is_ok());
        assert_eq!(
            parse_salt(&key(&[0; 15])),
            Err(FormatError::WrongLength {
                expected: 16,
                actual: 15
            })
        );
    }

    #[test]
    fn never_panics_on_random_input() {
        // A small deterministic xorshift generator: no dependency needed.
        let mut state: u64 = 0x5eed_5eed_5eed_5eed;
        let mut next = || {
            state ^= state << 13;
            state ^= state >> 7;
            state ^= state << 17;
            state
        };
        for _ in 0..5_000 {
            let len = (next() % 120) as usize;
            let bytes: Vec<u8> = (0..len).map(|_| next() as u8).collect();
            let as_b64 = to_base64(&bytes);
            let as_text: String = bytes.iter().map(|&b| (b % 95 + 32) as char).collect();
            for input in [as_b64.as_str(), as_text.as_str()] {
                let _ = parse_key_blob(input);
                let _ = parse_item_blob(input);
                let _ = parse_salt(input);
            }
        }
    }
}
