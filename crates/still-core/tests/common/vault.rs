// The vault backend's test stand-ins: keys with a fast password step, and
// storage in memory.

use std::cell::RefCell;
use std::collections::{BTreeMap, HashMap, HashSet};
use std::rc::Rc;

use still_core::crypto::{self, Key};
use still_core::session::{SecretText, SessionError, WrappedLensKey};
use still_core::sodium;
use still_core::vault::backend::{Keys, Storage, StorageError};
use still_core::Error;

// ---- a fast stand-in for the password step -------------------------------------

pub struct FastKeys {
    app: Key,
    lenses: HashMap<String, Key>,
}

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
}

// ---- storage in memory, shared across restarts -------------------------------------

#[derive(Default)]
pub struct Disk {
    pub data: BTreeMap<String, String>,
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
}
