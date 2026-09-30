use crate::format::FormatError;

/// Why a v1 crypto operation failed. It never carries secret material.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Error {
    /// Authentication failed: the password or key is wrong, or the bytes changed.
    WrongKey,
    /// The stored data is damaged or in an unknown format.
    Corrupt(FormatError),
    /// Argon2id couldn't run, for example because 1 GiB of memory wasn't available.
    PasswordHashFailed,
    /// A secret value that is empty or only whitespace (refused, as in the app).
    EmptyPlaintext,
    /// A decrypted value that isn't valid UTF-8.
    NotUtf8,
}

impl std::fmt::Display for Error {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::WrongKey => write!(f, "wrong password or key, or the data was changed"),
            Self::Corrupt(e) => write!(f, "damaged vault data: {e}"),
            Self::PasswordHashFailed => write!(f, "password hashing failed (not enough memory?)"),
            Self::EmptyPlaintext => write!(f, "a secret can't be empty or only whitespace"),
            Self::NotUtf8 => write!(f, "decrypted value is not valid UTF-8"),
        }
    }
}

impl std::error::Error for Error {}

impl From<FormatError> for Error {
    fn from(e: FormatError) -> Self {
        Self::Corrupt(e)
    }
}
