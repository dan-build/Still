//! How strong a master password typed by hand is: zxcvbn (Dropbox's
//! estimator, the `zxcvbn` crate), which spots common passwords, names,
//! dates, keyboard patterns and repeats. Advice only: it never decides
//! whether a password is accepted.
//!
//! zxcvbn works on copies of the password (its first 100 characters) that
//! are freed when it returns but not wiped, like the copies serde makes.

use crate::session::SecretText;

/// zxcvbn's verdict: a score from 0 (guessed in 10^3 tries or fewer) to 4
/// (more than 10^10), with at most one warning and a few suggestions, in
/// English.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Strength {
    pub score: u8,
    pub warning: Option<String>,
    pub suggestions: Vec<String>,
}

pub fn estimate(password: &SecretText) -> Strength {
    let entropy = zxcvbn::zxcvbn(password.expose(), &[]);
    let feedback = entropy.feedback();
    Strength {
        score: u8::from(entropy.score()),
        warning: feedback.and_then(|f| f.warning()).map(|w| w.to_string()),
        suggestions: feedback
            .map(|f| f.suggestions().iter().map(ToString::to_string).collect())
            .unwrap_or_default(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn rate(text: &str) -> Strength {
        estimate(&SecretText::from(text.to_owned()))
    }

    #[test]
    fn rates_common_passwords_low_and_long_random_ones_high() {
        for weak in [
            "password",
            "Password1!",
            "qwertyuiop",
            "12345678",
            "iloveyou",
        ] {
            let strength = rate(weak);
            assert!(strength.score <= 1, "{weak}: {strength:?}");
        }
        assert!(rate("password").warning.is_some());
        assert!(!rate("Password1!").suggestions.is_empty());
        for strong in ["velvet-orbit-candle-harbor-mosaic", "w%zByV@D&kemM5q=Hd=_"] {
            assert_eq!(rate(strong).score, 4, "{strong}");
        }
        assert_eq!(rate("").score, 0);
    }

    // A generated passphrase of the default length always rates 4.
    #[test]
    fn rates_generated_passphrases_strong() {
        for _ in 0..20 {
            let phrase = crate::generate::generate_passphrase(5).unwrap();
            assert_eq!(estimate(&phrase.value).score, 4);
        }
    }
}
