//! Shape checks for the stored master key and salt, done before any crypto
//! so that damaged data is reported as damaged rather than as a wrong password.

use crate::format::{parse_key_blob, parse_salt};

/// Whether the stored master key and salt have the v1 shape: version 1,
/// 73 bytes, and a 16-byte salt, both standard padded base64.
pub fn is_v1_master_key(encrypted_master_key: &str, salt: &str) -> bool {
    parse_key_blob(encrypted_master_key).is_ok() && parse_salt(salt).is_ok()
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::sodium::to_base64;

    fn blob(length: usize, version: u8) -> String {
        let mut bytes = vec![0u8; length];
        bytes[0] = version;
        to_base64(&bytes)
    }

    #[test]
    fn accepts_every_golden_vault() {
        for fixture in ["vault-v1", "vault-v1-real", "vault-v1-rust"] {
            let path = format!(
                "{}/../../fixtures/{fixture}/vault.json",
                env!("CARGO_MANIFEST_DIR")
            );
            let vault: serde_json::Value =
                serde_json::from_str(&std::fs::read_to_string(path).unwrap()).unwrap();
            let key = vault["still-encrypted-master-key"].as_str().unwrap();
            assert!(
                is_v1_master_key(key, vault["still-salt"].as_str().unwrap()),
                "{fixture}"
            );
        }
    }

    #[test]
    fn rejects_damaged_shapes() {
        let salt16 = to_base64(&[7; 16]);
        assert!(is_v1_master_key(&blob(73, 1), &salt16));
        assert!(!is_v1_master_key(&blob(73, 2), &salt16));
        assert!(!is_v1_master_key(&blob(72, 1), &salt16));
        assert!(!is_v1_master_key(&blob(40, 1), &salt16));
        assert!(!is_v1_master_key(&blob(73, 1), &to_base64(&[7; 15])));
        assert!(!is_v1_master_key("not base64!", &salt16));
        assert!(!is_v1_master_key(
            blob(73, 1).trim_end_matches('='),
            &salt16
        ));
        assert!(!is_v1_master_key(&blob(73, 1), "AAE"));
        assert!(!is_v1_master_key(&blob(73, 1), "AA-_AA-_AA-_AA-_AA-_AA=="));
    }
}
