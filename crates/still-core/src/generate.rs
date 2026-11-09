//! Random passwords for new secrets, from libsodium's random generator.
//!
//! Every character is drawn uniformly (`randombytes_uniform`, no modulo
//! bias) from the chosen kinds together. A password missing a chosen kind
//! is thrown away and drawn again, so each chosen kind appears at least
//! once and every password that qualifies is equally likely. Candidates
//! live in `SecretText`, which zeroes them when dropped.

use crate::session::SecretText;
use crate::sodium;

pub const MIN_LENGTH: usize = 8;
pub const MAX_LENGTH: usize = 64;

const LOWER: &str = "abcdefghijklmnopqrstuvwxyz";
const UPPER: &str = "ABCDEFGHIJKLMNOPQRSTUVWXYZ";
const DIGITS: &str = "0123456789";
/// Symbols websites accept: no quotes, backslash, space or brackets.
const SYMBOLS: &str = "!#$%&*+-=?@^_~";
/// Easy to misread when a password is typed by hand.
const LOOK_ALIKES: &str = "0Oo1lI|";

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Options {
    pub length: usize,
    pub lower: bool,
    pub upper: bool,
    pub digits: bool,
    pub symbols: bool,
    pub avoid_look_alikes: bool,
}

impl Default for Options {
    fn default() -> Self {
        Self {
            length: 20,
            lower: true,
            upper: true,
            digits: true,
            symbols: true,
            avoid_look_alikes: true,
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum GenerateError {
    /// The length is outside MIN_LENGTH..=MAX_LENGTH.
    Length,
    /// No kind of character was chosen.
    NoCharacters,
}

impl GenerateError {
    pub fn code(self) -> &'static str {
        match self {
            Self::Length => "bad-length",
            Self::NoCharacters => "no-characters",
        }
    }
}

/// A password and its strength in bits.
#[derive(Debug)]
pub struct Generated {
    pub value: SecretText,
    pub bits: u32,
}

/// The chosen kinds, each as its characters (look-alikes removed if asked).
fn kinds(options: &Options) -> Result<Vec<Vec<u8>>, GenerateError> {
    if !(MIN_LENGTH..=MAX_LENGTH).contains(&options.length) {
        return Err(GenerateError::Length);
    }
    let kinds: Vec<Vec<u8>> = [
        (options.lower, LOWER),
        (options.upper, UPPER),
        (options.digits, DIGITS),
        (options.symbols, SYMBOLS),
    ]
    .into_iter()
    .filter(|(chosen, _)| *chosen)
    .map(|(_, set)| {
        set.bytes()
            .filter(|b| !(options.avoid_look_alikes && LOOK_ALIKES.as_bytes().contains(b)))
            .collect()
    })
    .collect();
    if kinds.is_empty() {
        return Err(GenerateError::NoCharacters);
    }
    Ok(kinds)
}

/// How many bits of randomness a password with these options has: log2 of
/// the number of passwords that qualify (every chosen kind at least once,
/// counted by inclusion and exclusion), rounded down.
pub fn strength_bits(options: &Options) -> Result<u32, GenerateError> {
    let kinds = kinds(options)?;
    let n = kinds.iter().map(Vec::len).sum::<usize>() as f64;
    let length = options.length as i32;
    // The share of all n^length passwords that lack some chosen kind.
    let mut missing = 0.0;
    for subset in 1u32..(1 << kinds.len()) {
        let left: usize = kinds
            .iter()
            .enumerate()
            .filter(|(i, _)| subset & (1 << i) == 0)
            .map(|(_, kind)| kind.len())
            .sum();
        let sign = if subset.count_ones() % 2 == 1 {
            1.0
        } else {
            -1.0
        };
        missing += sign * (left as f64 / n).powi(length);
    }
    let bits = options.length as f64 * n.log2() + (1.0 - missing).log2();
    Ok(bits.floor() as u32)
}

/// A new random password with these options.
pub fn generate(options: &Options) -> Result<Generated, GenerateError> {
    let kinds = kinds(options)?;
    let bits = strength_bits(options)?;
    let alphabet: Vec<u8> = kinds.concat();
    loop {
        // ASCII only, and the capacity set up front: the text is never
        // reallocated, so no copy of it is left behind unzeroed.
        let mut text = String::with_capacity(options.length);
        for _ in 0..options.length {
            let i = sodium::random_uniform(alphabet.len() as u32) as usize;
            text.push(alphabet[i] as char);
        }
        let candidate = SecretText::from(text);
        let bytes = candidate.expose().as_bytes();
        if kinds
            .iter()
            .all(|kind| bytes.iter().any(|b| kind.contains(b)))
        {
            return Ok(Generated {
                value: candidate,
                bits,
            });
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn each_option_set() -> Vec<Options> {
        let mut all = Vec::new();
        for mask in 1u8..16 {
            for avoid_look_alikes in [false, true] {
                for length in [MIN_LENGTH, 13, MAX_LENGTH] {
                    all.push(Options {
                        length,
                        lower: mask & 1 != 0,
                        upper: mask & 2 != 0,
                        digits: mask & 4 != 0,
                        symbols: mask & 8 != 0,
                        avoid_look_alikes,
                    });
                }
            }
        }
        all
    }

    #[test]
    fn follows_every_combination_of_options() {
        for options in each_option_set() {
            let kinds = kinds(&options).unwrap();
            for _ in 0..20 {
                let password = generate(&options).unwrap();
                let bytes = password.value.expose().as_bytes();
                assert_eq!(bytes.len(), options.length, "{options:?}");
                assert!(
                    bytes.iter().all(|b| kinds.iter().any(|k| k.contains(b))),
                    "{options:?}: only the chosen kinds"
                );
                assert!(
                    kinds.iter().all(|k| bytes.iter().any(|b| k.contains(b))),
                    "{options:?}: every chosen kind at least once"
                );
                if options.avoid_look_alikes {
                    assert!(!bytes.iter().any(|b| LOOK_ALIKES.as_bytes().contains(b)));
                }
            }
        }
    }

    #[test]
    fn makes_a_different_password_each_time() {
        let a = generate(&Options::default()).unwrap();
        let b = generate(&Options::default()).unwrap();
        assert_ne!(a.value.expose(), b.value.expose());
        assert_eq!(format!("{:?}", a.value), "SecretText(redacted)");
    }

    #[test]
    fn refuses_options_it_cannot_follow() {
        let with = |length, lower, upper, digits, symbols| Options {
            length,
            lower,
            upper,
            digits,
            symbols,
            avoid_look_alikes: false,
        };
        assert_eq!(
            generate(&with(7, true, true, true, true)).unwrap_err(),
            GenerateError::Length
        );
        assert_eq!(
            generate(&with(65, true, true, true, true)).unwrap_err(),
            GenerateError::Length
        );
        assert_eq!(
            generate(&with(20, false, false, false, false)).unwrap_err(),
            GenerateError::NoCharacters
        );
        assert_eq!(GenerateError::Length.code(), "bad-length");
        assert_eq!(GenerateError::NoCharacters.code(), "no-characters");
    }

    #[test]
    fn counts_the_strength_in_bits() {
        let digits = |length, avoid_look_alikes| Options {
            length,
            lower: false,
            upper: false,
            digits: true,
            symbols: false,
            avoid_look_alikes,
        };
        // One kind: length × log2(characters), nothing to subtract.
        assert_eq!(strength_bits(&digits(8, false)), Ok(26)); // 8 × 3.32
        assert_eq!(strength_bits(&digits(8, true)), Ok(24)); // 8 × 3
                                                             // Where the at-least-one rule costs a little (values computed
                                                             // independently, with exact integer counts):
                                                             // the defaults, 70 characters, 20 long: 122.58 bits less the rule = 122.43;
        assert_eq!(strength_bits(&Options::default()), Ok(122));
        // all four kinds without avoiding look-alikes (76), 8 long:
        // 49.98 bits less the rule = 48.91.
        let all8 = Options {
            length: 8,
            avoid_look_alikes: false,
            ..Options::default()
        };
        assert_eq!(strength_bits(&all8), Ok(48));
    }

    // Every allowed character turns up about equally often: 2000 passwords
    // of 64 characters, about 1829 of each of the 70; the bound is 15%
    // (about six standard deviations).
    #[test]
    fn draws_every_character_about_equally_often() {
        let options = Options {
            length: MAX_LENGTH,
            ..Options::default()
        };
        let alphabet = kinds(&options).unwrap().concat();
        let mut counts = std::collections::HashMap::new();
        for _ in 0..2000 {
            for b in generate(&options).unwrap().value.expose().bytes() {
                *counts.entry(b).or_insert(0usize) += 1;
            }
        }
        let expected = 2000.0 * MAX_LENGTH as f64 / alphabet.len() as f64;
        assert_eq!(counts.len(), alphabet.len());
        for b in alphabet {
            let count = counts[&b] as f64;
            assert!(
                (count - expected).abs() < expected * 0.15,
                "{} came up {count} times, expected about {expected:.0}",
                b as char
            );
        }
    }
}
