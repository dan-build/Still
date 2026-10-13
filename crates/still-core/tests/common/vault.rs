// The vault backend's test stand-ins: keys with a fast password step, and
// storage in memory.

use std::cell::RefCell;
use std::collections::{BTreeMap, HashMap, HashSet};
use std::rc::Rc;

use still_core::crypto::{self, Key};
use still_core::session::{SecretText, SessionError, WrappedLensKey};
use still_core::sodium;
use still_core::v2;
use still_core::vault::backend::{Keys, Storage, StorageError};
use still_core::Error;

// ---- a fast stand-in for the password step -------------------------------------

pub struct FastKeys {
    app: Key,
    lenses: HashMap<String, Key>,
}

/// The stand-in password step: a keyed hash instead of Argon2id.
fn password_key(password: &SecretText, salt: &[u8]) -> Key {
    let mut input = password.expose().as_bytes().to_vec();
    input.extend_from_slice(salt);
    Key::from_bytes(sodium::blake2b_256(&input, None))
}

impl Keys for FastKeys {
    fn create(password: &SecretText) -> Result<(Self, String, String), SessionError> {
        let mut salt = [0u8; 16];
        sodium::random_bytes(&mut salt);
        let mut nonce = [0u8; 24];
        sodium::random_bytes(&mut nonce);
        let app = Key::random();
        let blob = crypto::wrap_key_with_nonce(&app, &password_key(password, &salt), nonce);
        let keys = Self {
            app,
            lenses: HashMap::new(),
        };
        Ok((keys, blob, sodium::to_base64(&salt)))
    }

    fn open(
        blob: &str,
        salt: &str,
        password: &SecretText,
        lenses: &[WrappedLensKey<'_>],
    ) -> Result<(Self, Vec<bool>), SessionError> {
        let salt = sodium::from_base64(salt).ok_or(SessionError::Corrupt)?;
        let app =
            crypto::decrypt_lens_key(blob, &password_key(password, &salt)).map_err(
                |e| match e {
                    Error::WrongKey => SessionError::WrongPassword,
                    _ => SessionError::Corrupt,
                },
            )?;
        let mut keys = HashMap::new();
        let opened = lenses
            .iter()
            .map(
                |lens| match crypto::decrypt_lens_key(lens.encrypted_master_key, &app) {
                    Ok(key) => {
                        keys.insert(lens.id.to_owned(), key);
                        true
                    }
                    Err(_) => false,
                },
            )
            .collect();
        Ok((Self { app, lenses: keys }, opened))
    }

    fn new_lens_key(&mut self, lens_id: &str) -> String {
        let key = Key::random();
        let wrapped = crypto::encrypt_lens_key(&key, &self.app);
        self.lenses.insert(lens_id.to_owned(), key);
        wrapped
    }

    fn encrypt_item(&self, lens_id: &str, plaintext: &SecretText) -> Result<String, SessionError> {
        let key = self.lenses.get(lens_id).ok_or(SessionError::UnknownLens)?;
        crypto::encrypt_item(plaintext.expose(), key).map_err(|_| SessionError::Failed)
    }

    fn decrypt_item(&self, lens_id: &str, blob: &str) -> Result<SecretText, SessionError> {
        let key = self.lenses.get(lens_id).ok_or(SessionError::UnknownLens)?;
        crypto::decrypt_item(blob, key)
            .map(SecretText::from)
            .map_err(|_| SessionError::Corrupt)
    }

    fn create_v2(password: &SecretText) -> Result<(Self, v2::File), SessionError> {
        let app = Key::random();
        let kdf = v2::Kdf::new_sensitive();
        let empty = v2::Body {
            lenses: "[]".into(),
            bin: "[]".into(),
        };
        let file = v2::seal_file(&app, &password_key(password, &kdf.salt), kdf, &empty, None);
        let keys = Self {
            app,
            lenses: HashMap::new(),
        };
        Ok((keys, file))
    }

    fn open_v2(file: &v2::File, password: &SecretText) -> Result<(Self, v2::Body), SessionError> {
        let app = file
            .open_master_key(&password_key(password, &file.kdf.salt))
            .map_err(|_| SessionError::WrongPassword)?;
        let body = file.open_body(&app).map_err(|_| SessionError::Corrupt)?;
        let keys = Self {
            app,
            lenses: HashMap::new(),
        };
        Ok((keys, body))
    }

    fn open_lens_keys(&mut self, lenses: &[WrappedLensKey<'_>]) -> Vec<bool> {
        lenses
            .iter()
            .map(
                |lens| match crypto::decrypt_lens_key(lens.encrypted_master_key, &self.app) {
                    Ok(key) => {
                        self.lenses.insert(lens.id.to_owned(), key);
                        true
                    }
                    Err(_) => false,
                },
            )
            .collect()
    }

    fn seal_v2(&self, file: &v2::File, body: &v2::Body) -> v2::File {
        file.with_body(body, &self.app)
    }

    fn convert_v2(&self, password: &SecretText, body: &v2::Body) -> Result<v2::File, SessionError> {
        let kdf = v2::Kdf::new_sensitive();
        let key = password_key(password, &kdf.salt);
        Ok(v2::seal_file(
            &self.app,
            &key,
            kdf,
            body,
            Some("vault-v1".into()),
        ))
    }
}

// ---- storage in memory, shared across restarts -------------------------------------

#[derive(Default)]
pub struct Disk {
    pub data: BTreeMap<String, String>,
    /// The vault file in format v2, as written (when there is one).
    pub v2: Option<String>,
    /// Whether new vaults are created in v2 here (and v1 ones converted).
    pub creates_v2: bool,
    /// The file exists but can't be read.
    pub unreadable: bool,
    /// The v1 values each conversion kept, in order.
    pub kept_v1: Vec<BTreeMap<String, String>>,
    pub fail_all: bool,
    pub fail_keys: HashSet<String>,
    pub writes: Vec<Vec<String>>,
}

#[derive(Clone, Default)]
pub struct Memory(pub Rc<RefCell<Disk>>);

impl Storage for Memory {
    fn get(&self, key: &str) -> Option<String> {
        self.0.borrow().data.get(key).cloned()
    }

    fn keys(&self) -> Vec<String> {
        self.0.borrow().data.keys().cloned().collect()
    }

    fn write(&mut self, changes: &[(String, Option<String>)]) -> Result<(), StorageError> {
        let mut disk = self.0.borrow_mut();
        if disk.fail_all || changes.iter().any(|(key, _)| disk.fail_keys.contains(key)) {
            return Err(StorageError);
        }
        disk.writes
            .push(changes.iter().map(|(key, _)| key.clone()).collect());
        for (key, value) in changes {
            match value {
                Some(value) => disk.data.insert(key.clone(), value.clone()),
                None => disk.data.remove(key),
            };
        }
        Ok(())
    }

    fn v2(&self) -> Option<v2::File> {
        v2::File::parse(self.0.borrow().v2.as_deref()?).ok()
    }

    fn write_v2(&mut self, file: &v2::File) -> Result<(), StorageError> {
        let mut disk = self.0.borrow_mut();
        // As the vault file: never a v2 write over v1 values (only the conversion).
        if disk.fail_all
            || disk.fail_keys.contains("v2")
            || !disk.data.is_empty()
            || disk.unreadable
        {
            return Err(StorageError);
        }
        disk.writes.push(vec!["v2".to_owned()]);
        disk.v2 = Some(file.to_json());
        Ok(())
    }

    fn creates_v2(&self) -> bool {
        // As the vault file: a new vault goes into v2 unless v1 values are there.
        let disk = self.0.borrow();
        disk.creates_v2 && disk.data.is_empty()
    }

    fn converts_v1(&self) -> bool {
        self.0.borrow().creates_v2
    }

    fn unreadable(&self) -> bool {
        self.0.borrow().unreadable
    }

    fn convert_to_v2(
        &mut self,
        file: &v2::File,
        lenses: &str,
        bin: &str,
    ) -> Result<(), StorageError> {
        let mut disk = self.0.borrow_mut();
        let stored = |key: &str| disk.data.get(key).cloned().unwrap_or_else(|| "[]".into());
        let unchanged = disk.v2.is_none()
            && stored("still-lenses") == lenses
            && stored("still-recycle-bin") == bin;
        if disk.fail_all || disk.fail_keys.contains("convert") || !unchanged {
            return Err(StorageError);
        }
        disk.writes.push(vec!["convert".to_owned()]);
        let kept = std::mem::take(&mut disk.data);
        disk.kept_v1.push(kept);
        disk.v2 = Some(file.to_json());
        Ok(())
    }
}
