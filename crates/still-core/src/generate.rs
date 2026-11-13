//! Random passwords for new secrets, and passphrases for the master
//! password, from libsodium's random generator.
//!
//! Every character is drawn uniformly (`randombytes_uniform`, no modulo
//! bias) from the chosen kinds together. A password missing a chosen kind
//! is thrown away and drawn again, so each chosen kind appears at least
//! once and every password that qualifies is equally likely. Candidates
//! live in `SecretText`, which zeroes them when dropped.

use crate::session::SecretText;
use crate::sodium;

/// The EFF's long word list for passphrases (CC BY 3.0 US), exactly as
/// published: `<dice>\t<word>` lines, 7,776 words. Its SHA-256 is pinned
/// by a test below; see data/README.md.
const WORD_LIST: &str = include_str!("../data/eff_large_wordlist.txt");
pub const MIN_WORDS: usize = 4;
pub const MAX_WORDS: usize = 8;

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
    /// A passphrase's word count is outside MIN_WORDS..=MAX_WORDS.
    WordCount,
}

impl GenerateError {
    pub fn code(self) -> &'static str {
        match self {
            Self::Length => "bad-length",
            Self::NoCharacters => "no-characters",
            Self::WordCount => "bad-word-count",
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

/// The passphrase words: the list's words, less the four with a hyphen in
/// them (drop-down, felt-tip, t-shirt, yo-yo), so a phrase joined with
/// hyphens splits back into exactly its words. 7,772 words.
pub fn words() -> &'static [&'static str] {
    static WORDS: std::sync::OnceLock<Vec<&'static str>> = std::sync::OnceLock::new();
    WORDS.get_or_init(|| {
        WORD_LIST
            .lines()
            .filter_map(|line| line.split_once('\t').map(|(_, word)| word))
            .filter(|word| !word.contains('-'))
            .collect()
    })
}

/// A passphrase of `count` words, each drawn uniformly from `words()`,
/// joined with hyphens, and its strength in bits (count × log2 of the list's
/// size, rounded down).
pub fn generate_passphrase(count: usize) -> Result<Generated, GenerateError> {
    if !(MIN_WORDS..=MAX_WORDS).contains(&count) {
        return Err(GenerateError::WordCount);
    }
    let words = words();
    let picked: Vec<&str> = (0..count)
        .map(|_| words[sodium::random_uniform(words.len() as u32) as usize])
        .collect();
    // The capacity set up front: the text is never reallocated, so no copy
    // of it is left behind unzeroed.
    let length = picked.iter().map(|w| w.len()).sum::<usize>() + count - 1;
    let mut text = String::with_capacity(length);
    for (i, word) in picked.iter().enumerate() {
        if i > 0 {
            text.push('-');
        }
        text.push_str(word);
    }
    let bits = (count as f64 * (words.len() as f64).log2()).floor() as u32;
    Ok(Generated {
        value: SecretText::from(text),
        bits,
    })
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

    // The list exactly as the EFF published it (pinned by its SHA-256),
    // less its four hyphenated words.
    #[test]
    fn reads_the_eff_long_word_list() {
        let digest: String = sodium::sha256(WORD_LIST.as_bytes())
            .iter()
            .map(|b| format!("{b:02x}"))
            .collect();
        assert_eq!(
            digest,
            "addd35536511597a02fa0a9ff1e5284677b8883b83e986e43f15a3db996b903e"
        );
        assert_eq!(WORD_LIST.lines().count(), 7776);
        let words = words();
        assert_eq!(words.len(), 7772);
        assert_eq!((words[0], words[words.len() - 1]), ("abacus", "zoom"));
        let unique: std::collections::HashSet<_> = words.iter().collect();
        assert_eq!(unique.len(), words.len());
        assert!(words
            .iter()
            .all(|w| !w.is_empty() && w.bytes().all(|b| b.is_ascii_lowercase())));
    }

    #[test]
    fn makes_passphrases_of_known_words() {
        let known: std::collections::HashSet<_> = words().iter().copied().collect();
        for count in MIN_WORDS..=MAX_WORDS {
            for _ in 0..20 {
                let phrase = generate_passphrase(count).unwrap();
                let parts: Vec<&str> = phrase.value.expose().split('-').collect();
                assert_eq!(parts.len(), count);
                assert!(parts.iter().all(|w| known.contains(w)));
                // 12.92 bits a word.
                assert_eq!(phrase.bits, (count as f64 * 7772f64.log2()).floor() as u32);
            }
        }
        assert_eq!(generate_passphrase(5).unwrap().bits, 64);
        assert_ne!(
            generate_passphrase(5).unwrap().value.expose(),
            generate_passphrase(5).unwrap().value.expose()
        );
        for count in [0, 3, 9] {
            assert_eq!(
                generate_passphrase(count).unwrap_err(),
                GenerateError::WordCount
            );
        }
        assert_eq!(GenerateError::WordCount.code(), "bad-word-count");
    }
}
