//! Vault format v2 (docs/vault-format-v2.md): the whole vault body is
//! encrypted, every part of the file is bound to the rest by associated
//! data, and the Argon2id settings are recorded. Built only from the v1
//! primitives: Argon2id, XChaCha20-Poly1305 IETF and crypto_kdf, all from
//! libsodium.
//!
//! ```json
//! { "format": "still-vault", "formatVersion": 2,
//!   "kdf": { "algorithm": "argon2id13", "opsLimit": 4, "memLimit": 1073741824, "salt": "…" },
//!   "masterKey": "…", "body": "…", "check": "…", "migratedFrom": "vault-v1" }
//! ```
//!
//! Errors, as the design's table says: anything wrong in the header is
//! `Corrupt` before Argon2id runs; a `masterKey` that doesn't open is
//! `WrongKey` (a wrong password, or a tampered file: they can't be told
//! apart); a body that doesn't open after the key did is `Corrupt(DamagedBody)`.

use serde_json::{json, Map, Value};

use crate::crypto::Key;
use crate::error::Error;
use crate::format::{FormatError, KEY_BYTES, NONCE_BYTES, SALT_BYTES, TAG_BYTES};
use crate::sodium;

pub const FORMAT: &str = "still-vault";
pub const FORMAT_VERSION: u64 = 2;
/// The first byte of both v2 blobs.
pub const BLOB_VERSION: u8 = 2;
pub const MASTER_KEY_BYTES: usize = 1 + NONCE_BYTES + KEY_BYTES + TAG_BYTES;
const BODY_MIN_BYTES: usize = 1 + NONCE_BYTES + TAG_BYTES;

const ALGORITHM: &str = "argon2id13";
pub const OPS_MIN: u64 = sodium::ARGON2ID_OPS_SENSITIVE;
pub const OPS_MAX: u64 = 16;
pub const MEM_MIN: u64 = sodium::ARGON2ID_MEM_SENSITIVE;
pub const MEM_MAX: u64 = 4 << 30;

const MASTER_KEY_AD: &[u8] = b"still-vault/2/master-key\0";
const BODY_AD: &[u8] = b"still-vault/2/body\0";
const CHECK_DOMAIN: &[u8] = b"still-vault/2/check\0";
const BODY_KEY_ID: u64 = 1;
const BODY_KEY_CONTEXT: &[u8; 8] = b"StillVlt";
/// The body's plaintext is padded to a multiple of this.
pub const BODY_PADDING: usize = 4096;

/// The Argon2id settings and salt, as recorded in the header.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Kdf {
    pub ops_limit: u64,
    pub mem_limit: u64,
    pub salt: [u8; SALT_BYTES],
}

impl Kdf {
    /// libsodium's SENSITIVE limits, as v1 used, with this salt.
    pub fn sensitive(salt: [u8; SALT_BYTES]) -> Self {
        Self {
            ops_limit: OPS_MIN,
            mem_limit: MEM_MIN,
            salt,
        }
    }

    /// SENSITIVE limits with a fresh random salt.
    pub fn new_sensitive() -> Self {
        let mut salt = [0u8; SALT_BYTES];
        sodium::random_bytes(&mut salt);
        Self::sensitive(salt)
    }

    /// The fixed binary layout bound into the associated data: algorithm id,
    /// ops limit and mem limit (u64 little-endian), salt.
    pub fn block(&self) -> [u8; 33] {
        let mut block = [0u8; 33];
        block[0] = sodium::ARGON2ID13;
        block[1..9].copy_from_slice(&self.ops_limit.to_le_bytes());
        block[9..17].copy_from_slice(&self.mem_limit.to_le_bytes());
        block[17..].copy_from_slice(&self.salt);
        block
    }

    fn check_limits(&self) -> Result<(), FormatError> {
        if !(OPS_MIN..=OPS_MAX).contains(&self.ops_limit) {
            return Err(FormatError::InvalidHeader("opsLimit out of range"));
        }
        if !(MEM_MIN..=MEM_MAX).contains(&self.mem_limit) {
            return Err(FormatError::InvalidHeader("memLimit out of range"));
        }
        Ok(())
    }

    /// The password key: Argon2id over the password's UTF-8 bytes. Refuses
    /// limits outside the allowed range before running anything.
    pub fn password_key(&self, password: &str) -> Result<Key, Error> {
        self.check_limits()?;
        let mut out = [0u8; KEY_BYTES];
        let result = sodium::argon2id(
            &mut out,
            password.as_bytes(),
            &self.salt,
            self.ops_limit,
            self.mem_limit,
        );
        let key = Key::from_bytes(out);
        sodium::memzero(&mut out);
        result.map_err(|_| Error::PasswordHashFailed)?;
        Ok(key)
    }
}

/// A v2 vault file, parsed (or about to be written).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct File {
    pub kdf: Kdf,
    /// `[2][nonce 24][app key 32 + tag 16]`
    pub master_key: [u8; MASTER_KEY_BYTES],
    /// `[2][nonce 24][ciphertext + tag 16]`
    pub body: Vec<u8>,
    /// Informational only: nothing acts on it.
    pub migrated_from: Option<String>,
}

fn invalid(why: &'static str) -> FormatError {
    FormatError::InvalidHeader(why)
}

/// Canonical, padded base64 only: it must re-encode to the same text.
fn canonical_base64(text: &str) -> Option<Vec<u8>> {
    let bytes = sodium::from_base64(text)?;
    (sodium::to_base64(&bytes) == text).then_some(bytes)
}

fn hex(bytes: &[u8]) -> String {
    bytes.iter().map(|b| format!("{b:02x}")).collect()
}

/// An object with exactly these keys (and optionally these), else Err.
fn exact_object<'a>(
    value: &'a Value,
    required: &[&str],
    optional: &[&str],
    why: &'static str,
) -> Result<&'a Map<String, Value>, FormatError> {
    let map = value.as_object().ok_or(invalid(why))?;
    let known = |key: &String| required.contains(&key.as_str()) || optional.contains(&key.as_str());
    if !map.keys().all(known) || !required.iter().all(|k| map.contains_key(*k)) {
        return Err(invalid(why));
    }
    Ok(map)
}

/// A plain decimal integer: serde_json reads `4.0` or `1e9` as a float,
/// and a sign or more than u64 as something other than u64, so those fail.
fn integer(value: &Value, why: &'static str) -> Result<u64, FormatError> {
    match value {
        Value::Number(n) if n.is_u64() => n.as_u64().ok_or(invalid(why)),
        _ => Err(invalid(why)),
    }
}

impl File {
    /// Reads a v2 file strictly: exactly the fields v2 writes, canonical
    /// encodings, limits in range, and a matching checksum. Anything else is
    /// damaged data, found before any Argon2id run.
    pub fn parse(text: &str) -> Result<Self, FormatError> {
        let value: Value = serde_json::from_str(text).map_err(|_| invalid("not JSON"))?;
        let top = exact_object(
            &value,
            &[
                "format",
                "formatVersion",
                "kdf",
                "masterKey",
                "body",
                "check",
            ],
            &["migratedFrom"],
            "unexpected fields",
        )?;
        if top["format"] != FORMAT {
            return Err(invalid("not a Still vault"));
        }
        if integer(&top["formatVersion"], "formatVersion")? != FORMAT_VERSION {
            return Err(invalid("formatVersion"));
        }
        let kdf_fields = exact_object(
            &top["kdf"],
            &["algorithm", "opsLimit", "memLimit", "salt"],
            &[],
            "kdf fields",
        )?;
        if kdf_fields["algorithm"] != ALGORITHM {
            return Err(invalid("algorithm"));
        }
        let salt = kdf_fields["salt"]
            .as_str()
            .and_then(canonical_base64)
            .and_then(|s| <[u8; SALT_BYTES]>::try_from(s).ok())
            .ok_or(invalid("salt"))?;
        let kdf = Kdf {
            ops_limit: integer(&kdf_fields["opsLimit"], "opsLimit")?,
            mem_limit: integer(&kdf_fields["memLimit"], "memLimit")?,
            salt,
        };
        kdf.check_limits()?;
        let master_key = top["masterKey"]
            .as_str()
            .and_then(canonical_base64)
            .and_then(|k| <[u8; MASTER_KEY_BYTES]>::try_from(k).ok())
            .filter(|k| k[0] == BLOB_VERSION)
            .ok_or(invalid("masterKey"))?;
        let body = top["body"]
            .as_str()
            .and_then(canonical_base64)
            .filter(|b| b.len() >= BODY_MIN_BYTES && b[0] == BLOB_VERSION)
            .ok_or(invalid("body"))?;
        let migrated_from = match top.get("migratedFrom") {
            None => None,
            Some(Value::String(s)) => Some(s.clone()),
            Some(_) => return Err(invalid("migratedFrom")),
        };
        let file = Self {
            kdf,
            master_key,
            body,
            migrated_from,
        };
        if top["check"].as_str() != Some(file.check().as_str()) {
            return Err(invalid("check"));
        }
        Ok(file)
    }

    /// BLAKE2b-256 over every field. Only so accidental damage shows as
    /// damaged data; anyone can recompute it.
    fn check(&self) -> String {
        let mut input = CHECK_DOMAIN.to_vec();
        input.extend_from_slice(&self.kdf.block());
        input.extend_from_slice(&self.master_key);
        input.extend_from_slice(&(self.body.len() as u64).to_le_bytes());
        input.extend_from_slice(&self.body);
        if let Some(from) = &self.migrated_from {
            input.extend_from_slice(from.as_bytes());
        }
        hex(&sodium::blake2b_256(&input, None))
    }

    /// The file as v2 writes it (pretty JSON, a final newline).
    pub fn to_json(&self) -> String {
        let mut file = json!({
            "format": FORMAT,
            "formatVersion": FORMAT_VERSION,
            "kdf": {
                "algorithm": ALGORITHM,
                "opsLimit": self.kdf.ops_limit,
                "memLimit": self.kdf.mem_limit,
                "salt": sodium::to_base64(&self.kdf.salt),
            },
            "masterKey": sodium::to_base64(&self.master_key),
            "body": sodium::to_base64(&self.body),
            "check": self.check(),
        });
        if let Some(from) = &self.migrated_from {
            file["migratedFrom"] = json!(from);
        }
        let mut text = serde_json::to_string_pretty(&file).expect("JSON values serialise");
        text.push('\n');
        text
    }

    /// The app key, with the password key. A failure is `WrongKey`: a wrong
    /// password, or a changed salt, setting or key (they can't be told apart).
    pub fn open_master_key(&self, password_key: &Key) -> Result<Key, Error> {
        open_master_key(&self.master_key, &self.kdf, password_key)
    }

    /// The vault's lists. The body key comes from the app key.
    pub fn open_body(&self, app_key: &Key) -> Result<Body, Error> {
        open_body(&self.body, &self.kdf, &self.master_key, app_key)
    }

    /// Reseals the body for a save; `kdf` and `masterKey` stay as they are.
    pub fn with_body(&self, body: &Body, app_key: &Key) -> Self {
        Self {
            body: seal_body(body, &self.kdf, &self.master_key, app_key, random_nonce()),
            ..self.clone()
        }
    }
}

fn random_nonce() -> [u8; NONCE_BYTES] {
    let mut nonce = [0u8; NONCE_BYTES];
    sodium::random_bytes(&mut nonce);
    nonce
}

fn master_key_ad(kdf: &Kdf) -> Vec<u8> {
    [MASTER_KEY_AD, &kdf.block()].concat()
}

fn body_ad(kdf: &Kdf, master_key: &[u8; MASTER_KEY_BYTES]) -> Vec<u8> {
    [BODY_AD, &kdf.block(), master_key].concat()
}

/// Wraps the app key under the password key, bound to the KDF settings.
pub fn wrap_master_key(
    app_key: &Key,
    password_key: &Key,
    kdf: &Kdf,
    nonce: [u8; NONCE_BYTES],
) -> [u8; MASTER_KEY_BYTES] {
    let sealed = sodium::aead_encrypt(
        app_key.expose(),
        &master_key_ad(kdf),
        &nonce,
        password_key.expose(),
    );
    let mut blob = [0u8; MASTER_KEY_BYTES];
    blob[0] = BLOB_VERSION;
    blob[1..1 + NONCE_BYTES].copy_from_slice(&nonce);
    blob[1 + NONCE_BYTES..].copy_from_slice(&sealed);
    blob
}

fn open_master_key(
    blob: &[u8; MASTER_KEY_BYTES],
    kdf: &Kdf,
    password_key: &Key,
) -> Result<Key, Error> {
    let nonce: [u8; NONCE_BYTES] = blob[1..1 + NONCE_BYTES].try_into().expect("fixed size");
    let mut opened = sodium::aead_decrypt(
        &blob[1 + NONCE_BYTES..],
        &master_key_ad(kdf),
        &nonce,
        password_key.expose(),
    )
    .map_err(|_| Error::WrongKey)?;
    let key = <[u8; KEY_BYTES]>::try_from(opened.as_slice())
        .map(Key::from_bytes)
        .map_err(|_| Error::WrongKey);
    sodium::memzero(&mut opened);
    key
}

/// The body key: crypto_kdf from the app key (id 1, context "StillVlt").
pub fn body_key(app_key: &Key) -> Key {
    let mut out = [0u8; KEY_BYTES];
    sodium::kdf_derive(&mut out, BODY_KEY_ID, BODY_KEY_CONTEXT, app_key.expose());
    let key = Key::from_bytes(out);
    sodium::memzero(&mut out);
    key
}

/// The vault's two lists, as the v1 strings `still-lenses` and
/// `still-recycle-bin`. Zeroed when dropped.
pub struct Body {
    pub lenses: String,
    pub bin: String,
}

fn zero_string(text: &mut String) {
    let mut bytes = std::mem::take(text).into_bytes();
    bytes.resize(bytes.capacity(), 0);
    sodium::memzero(&mut bytes);
}

impl Drop for Body {
    fn drop(&mut self) {
        zero_string(&mut self.lenses);
        zero_string(&mut self.bin);
    }
}

impl std::fmt::Debug for Body {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str("Body(redacted)")
    }
}

impl Body {
    /// `[u32 LE length][JSON][zeros to a multiple of 4096]`, the JSON being
    /// `{"lenses":"…","bin":"…"}` with the two lists as strings.
    pub fn frame(&self) -> Vec<u8> {
        let mut json = format!(
            "{{\"lenses\":{},\"bin\":{}}}",
            serde_json::to_string(&self.lenses).expect("strings serialise"),
            serde_json::to_string(&self.bin).expect("strings serialise"),
        );
        let length = u32::try_from(json.len()).expect("a vault fits in 4 GiB");
        let total = (4 + json.len()).div_ceil(BODY_PADDING) * BODY_PADDING;
        let mut framed = Vec::with_capacity(total);
        framed.extend_from_slice(&length.to_le_bytes());
        framed.extend_from_slice(json.as_bytes());
        framed.resize(total, 0);
        zero_string(&mut json);
        framed
    }

    /// Reads a framed body. Only Still writes one (it's authenticated), so
    /// anything unexpected is damaged data.
    pub fn unframe(framed: &[u8]) -> Result<Self, FormatError> {
        let damaged = || FormatError::DamagedBody;
        let length = framed
            .get(..4)
            .map(|l| u32::from_le_bytes(l.try_into().expect("4 bytes")) as usize)
            .ok_or_else(damaged)?;
        let json = framed.get(4..4 + length).ok_or_else(damaged)?;
        let padding_ok = framed[4 + length..].iter().all(|&b| b == 0)
            && framed.len().is_multiple_of(BODY_PADDING);
        if !padding_ok {
            return Err(damaged());
        }
        let value: Value = serde_json::from_slice(json).map_err(|_| damaged())?;
        let map = value
            .as_object()
            .filter(|m| m.len() == 2)
            .ok_or_else(damaged)?;
        let text = |key: &str| map.get(key).and_then(Value::as_str).map(str::to_owned);
        match (text("lenses"), text("bin")) {
            (Some(lenses), Some(bin)) => Ok(Self { lenses, bin }),
            _ => Err(damaged()),
        }
    }
}

/// Seals the body under the body key, bound to the KDF settings and the
/// wrapped app key.
pub fn seal_body(
    body: &Body,
    kdf: &Kdf,
    master_key: &[u8; MASTER_KEY_BYTES],
    app_key: &Key,
    nonce: [u8; NONCE_BYTES],
) -> Vec<u8> {
    let mut framed = body.frame();
    let sealed = sodium::aead_encrypt(
        &framed,
        &body_ad(kdf, master_key),
        &nonce,
        body_key(app_key).expose(),
    );
    sodium::memzero(&mut framed);
    let mut blob = Vec::with_capacity(1 + NONCE_BYTES + sealed.len());
    blob.push(BLOB_VERSION);
    blob.extend_from_slice(&nonce);
    blob.extend_from_slice(&sealed);
    blob
}

fn open_body(
    blob: &[u8],
    kdf: &Kdf,
    master_key: &[u8; MASTER_KEY_BYTES],
    app_key: &Key,
) -> Result<Body, Error> {
    let damaged = Error::Corrupt(FormatError::DamagedBody);
    if blob.len() < BODY_MIN_BYTES || blob[0] != BLOB_VERSION {
        return Err(damaged);
    }
    let nonce: [u8; NONCE_BYTES] = blob[1..1 + NONCE_BYTES].try_into().expect("fixed size");
    let mut framed = sodium::aead_decrypt(
        &blob[1 + NONCE_BYTES..],
        &body_ad(kdf, master_key),
        &nonce,
        body_key(app_key).expose(),
    )
    .map_err(|_| damaged.clone())?;
    let body = Body::unframe(&framed).map_err(Error::Corrupt);
    sodium::memzero(&mut framed);
    body
}

/// A new v2 file: the app key wrapped under `password_key` (derived with
/// `kdf`), and the body sealed. The caller checks it opens before storing it.
pub fn seal_file(
    app_key: &Key,
    password_key: &Key,
    kdf: Kdf,
    body: &Body,
    migrated_from: Option<String>,
) -> File {
    let master_key = wrap_master_key(app_key, password_key, &kdf, random_nonce());
    let body = seal_body(body, &kdf, &master_key, app_key, random_nonce());
    File {
        kdf,
        master_key,
        body,
        migrated_from,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn body(lenses: &str, bin: &str) -> Body {
        Body {
            lenses: lenses.into(),
            bin: bin.into(),
        }
    }

    /// A file sealed with a fixed password key (no Argon2id in unit tests).
    fn sample(app_key: &Key, password_key: &Key) -> File {
        seal_file(
            app_key,
            password_key,
            Kdf::sensitive([7; 16]),
            &body("[{\"id\":\"a\",\"name\":\"Work\"}]", "[]"),
            Some("vault-v1".into()),
        )
    }

    #[test]
    fn round_trips_a_file_through_its_json() {
        let (app, password) = (Key::random(), Key::random());
        let file = sample(&app, &password);
        let parsed = File::parse(&file.to_json()).unwrap();
        assert_eq!(parsed, file);
        assert!(parsed.open_master_key(&password).unwrap().same_as(&app));
        let opened = parsed.open_body(&app).unwrap();
        assert_eq!(opened.lenses, "[{\"id\":\"a\",\"name\":\"Work\"}]");
        assert_eq!(opened.bin, "[]");
    }

    #[test]
    fn keeps_names_and_labels_out_of_the_file() {
        let file = sample(&Key::random(), &Key::random()).to_json();
        assert!(!file.contains("Work") && !file.contains("lenses"));
    }

    #[test]
    fn pads_the_body_to_hide_its_size() {
        let small = body("[]", "[]").frame();
        assert_eq!(small.len(), BODY_PADDING);
        let large = body(&"x".repeat(5000), "[]").frame();
        assert_eq!(large.len(), 2 * BODY_PADDING);
        assert_eq!(Body::unframe(&large).unwrap().lenses.len(), 5000);
    }

    #[test]
    fn a_wrong_password_key_is_a_wrong_key() {
        let file = sample(&Key::random(), &Key::random());
        assert_eq!(
            file.open_master_key(&Key::random()).err(),
            Some(Error::WrongKey)
        );
    }

    // Any changed byte in a blob fails, and so does moving a body between vaults.
    #[test]
    fn detects_every_change_to_the_blobs() {
        let (app, password) = (Key::random(), Key::random());
        let file = sample(&app, &password);
        // (The version byte, at 0, is checked by parse.)
        for at in [1, 24, 25, 56, 72] {
            let mut changed = file.clone();
            changed.master_key[at] ^= 1;
            assert_eq!(
                changed.open_master_key(&password).err(),
                Some(Error::WrongKey)
            );
        }
        for at in [1, 24, 25, file.body.len() / 2, file.body.len() - 1] {
            let mut changed = file.clone();
            changed.body[at] ^= 1;
            assert_eq!(
                changed.open_body(&app).err(),
                Some(Error::Corrupt(FormatError::DamagedBody)),
                "body byte {at}"
            );
        }
        // A body bound to another vault's master key, or settings, doesn't open.
        let other = sample(&app, &Key::random());
        let spliced = File {
            body: other.body.clone(),
            ..file.clone()
        };
        assert!(spliced.open_body(&app).is_err());
        let mut raised = file.clone();
        raised.kdf.ops_limit = 5;
        assert!(raised.open_master_key(&password).is_err());
        assert!(raised.open_body(&app).is_err());
    }

    #[test]
    fn refuses_any_header_that_isnt_exactly_v2() {
        let file = sample(&Key::random(), &Key::random());
        let good: Value = serde_json::from_str(&file.to_json()).unwrap();
        type Edit = Box<dyn Fn(&mut Value)>;
        let edits: Vec<(&str, Edit)> = vec![
            ("unknown field", Box::new(|v| v["extra"] = json!(1))),
            ("format", Box::new(|v| v["format"] = json!("other"))),
            ("version 1", Box::new(|v| v["formatVersion"] = json!(1))),
            ("version 2.0", Box::new(|v| v["formatVersion"] = json!(2.0))),
            (
                "algorithm",
                Box::new(|v| v["kdf"]["algorithm"] = json!("argon2i13")),
            ),
            ("ops too low", Box::new(|v| v["kdf"]["opsLimit"] = json!(3))),
            (
                "ops too high",
                Box::new(|v| v["kdf"]["opsLimit"] = json!(17)),
            ),
            (
                "ops as float",
                Box::new(|v| v["kdf"]["opsLimit"] = json!(4.0)),
            ),
            (
                "mem too low",
                Box::new(|v| v["kdf"]["memLimit"] = json!(MEM_MIN - 1)),
            ),
            (
                "mem too high",
                Box::new(|v| v["kdf"]["memLimit"] = json!(MEM_MAX + 1)),
            ),
            (
                "negative mem",
                Box::new(|v| v["kdf"]["memLimit"] = json!(-1)),
            ),
            ("kdf extra", Box::new(|v| v["kdf"]["pepper"] = json!("x"))),
            (
                "short salt",
                Box::new(|v| v["kdf"]["salt"] = json!(sodium::to_base64(&[1; 15]))),
            ),
            (
                "unpadded salt",
                Box::new(|v| v["kdf"]["salt"] = json!("BwcHBwcHBwcHBwcHBwcHBw")),
            ),
            (
                "masterKey",
                Box::new(|v| v["masterKey"] = json!(sodium::to_base64(&[2; 72]))),
            ),
            (
                "body version",
                Box::new(|v| v["body"] = json!(sodium::to_base64(&[1; 64]))),
            ),
            ("check", Box::new(|v| v["check"] = json!("00"))),
            (
                "migratedFrom type",
                Box::new(|v| v["migratedFrom"] = json!(1)),
            ),
            (
                "missing check",
                Box::new(|v| {
                    v.as_object_mut().unwrap().remove("check");
                }),
            ),
        ];
        assert!(File::parse(&good.to_string()).is_ok());
        for (what, edit) in edits {
            let mut changed = good.clone();
            edit(&mut changed);
            assert!(
                matches!(
                    File::parse(&changed.to_string()),
                    Err(FormatError::InvalidHeader(_))
                ),
                "{what}"
            );
        }
        // An edit the checksum doesn't cover is still caught by it.
        let mut edited = good.clone();
        edited["migratedFrom"] = json!("somewhere else");
        assert!(File::parse(&edited.to_string()).is_err());
    }

    #[test]
    fn refuses_settings_out_of_range_before_running_argon2id() {
        let mut kdf = Kdf::sensitive([0; 16]);
        kdf.mem_limit = MEM_MAX + 1;
        assert!(matches!(kdf.password_key("pw"), Err(Error::Corrupt(_))));
        kdf.mem_limit = MEM_MIN;
        kdf.ops_limit = 1;
        assert!(matches!(kdf.password_key("pw"), Err(Error::Corrupt(_))));
    }

    #[test]
    fn refuses_a_damaged_frame() {
        let framed = body("[]", "[]").frame();
        let mut long = framed.clone();
        long[0] = 200;
        long[1] = 200;
        assert!(Body::unframe(&long).is_err());
        let mut dirty_padding = framed.clone();
        *dirty_padding.last_mut().unwrap() = 1;
        assert!(Body::unframe(&dirty_padding).is_err());
        assert!(Body::unframe(&framed[..100]).is_err());
    }

    // With SENSITIVE limits, the password key is exactly v1's Argon2id output,
    // so the settings v1 used are the ones v2 records.
    #[test]
    fn sensitive_settings_derive_what_v1_derives() {
        let salt = [9u8; 16];
        let v2 = Kdf::sensitive(salt).password_key("pw-123456").unwrap();
        let v1 = crate::crypto::derive_key_from_password("pw-123456", &salt).unwrap();
        assert!(v2.same_as(&v1));
    }
}
