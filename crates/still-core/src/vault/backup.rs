//! Checking a backup before it replaces the vault: a backup is a vault file
//! in format v2, and it must open with its own password. Nothing here reads
//! or changes the current vault.

use serde_json::Value;

use super::backend::Keys;
use super::json::parse_list;
use crate::session::{SecretText, SessionError};
use crate::v2;

/// What a backup holds, to show before it's restored.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Summary {
    pub lenses: usize,
    pub secrets: usize,
    pub archived: usize,
}

/// Why a backup can't be restored.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum BackupError {
    /// Not a Still vault in format v2 (another file, or a damaged header).
    NotAVault,
    WrongPassword,
    /// The password opened it, but its contents are damaged.
    Damaged,
    /// Anything else, such as not enough memory for Argon2id.
    Failed,
}

impl BackupError {
    pub fn code(self) -> &'static str {
        match self {
            Self::NotAVault => "not-a-vault",
            Self::WrongPassword => "wrong-password",
            Self::Damaged => "damaged",
            Self::Failed => "failed",
        }
    }
}

/// Reads a backup file's text as a v2 vault, before any password step.
pub fn parse(text: &str) -> Result<v2::File, BackupError> {
    v2::File::parse(text).map_err(|_| BackupError::NotAVault)
}

/// Opens a backup with its password (Argon2id with its recorded settings)
/// and counts what it holds. Its lists must read as the backend reads them.
pub fn check<K: Keys>(file: &v2::File, password: &SecretText) -> Result<Summary, BackupError> {
    let (_, body) = K::open_v2(file, password).map_err(|e| match e {
        SessionError::WrongPassword => BackupError::WrongPassword,
        SessionError::Corrupt => BackupError::Damaged,
        _ => BackupError::Failed,
    })?;
    let lenses = parse_list(Some(&body.lenses)).map_err(|_| BackupError::Damaged)?;
    let bin = parse_list(Some(&body.bin)).map_err(|_| BackupError::Damaged)?;
    let items = |lens: &Value| {
        lens.get("items")
            .and_then(Value::as_array)
            .map_or(0, Vec::len)
    };
    Ok(Summary {
        lenses: lenses.len(),
        secrets: lenses.iter().map(items).sum(),
        archived: bin.len(),
    })
}
