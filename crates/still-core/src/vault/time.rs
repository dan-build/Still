//! Times as the vault stores them: milliseconds since 1970 (UTC), written as
//! JavaScript's `Date.prototype.toISOString()` does (`2026-10-08T12:00:00.000Z`),
//! and read the way `new Date(value)` reads a stored `deletedAt`.

use serde_json::Value;

const MS_PER_DAY: i64 = 86_400_000;
/// JavaScript's time range: ±8.64e15 ms (100 million days either side of 1970).
const MAX_TIME: i64 = 8_640_000_000_000_000;

/// Days since 1970-01-01 for a proleptic Gregorian date (Howard Hinnant's algorithm).
fn days_from_civil(year: i64, month: i64, day: i64) -> i64 {
    let y = if month <= 2 { year - 1 } else { year };
    let era = y.div_euclid(400);
    let yoe = y - era * 400;
    let mp = (month + 9) % 12;
    let doy = (153 * mp + 2) / 5 + day - 1;
    let doe = yoe * 365 + yoe / 4 - yoe / 100 + doy;
    era * 146_097 + doe - 719_468
}

/// The date for a count of days since 1970-01-01.
fn civil_from_days(days: i64) -> (i64, i64, i64) {
    let z = days + 719_468;
    let era = z.div_euclid(146_097);
    let doe = z - era * 146_097;
    let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let day = doy - (153 * mp + 2) / 5 + 1;
    let month = if mp < 10 { mp + 3 } else { mp - 9 };
    (yoe + era * 400 + i64::from(month <= 2), month, day)
}

fn days_in_month(year: i64, month: i64) -> i64 {
    match month {
        4 | 6 | 9 | 11 => 30,
        2 if year % 4 == 0 && (year % 100 != 0 || year % 400 == 0) => 29,
        2 => 28,
        _ => 31,
    }
}

/// `Date.prototype.toISOString()`: always UTC, always milliseconds; years
/// outside 0..=9999 get a sign and six digits.
pub fn to_iso(ms: i64) -> String {
    let (days, time) = (ms.div_euclid(MS_PER_DAY), ms.rem_euclid(MS_PER_DAY));
    let (year, month, day) = civil_from_days(days);
    let year = match year {
        0..=9999 => format!("{year:04}"),
        y if y < 0 => format!("-{:06}", -y),
        y => format!("+{y:06}"),
    };
    format!(
        "{year}-{month:02}-{day:02}T{:02}:{:02}:{:02}.{:03}Z",
        time / 3_600_000,
        time / 60_000 % 60,
        time / 1000 % 60,
        time % 1000
    )
}

/// Reads the ECMAScript date time string format: `YYYY`, `YYYY-MM` or
/// `YYYY-MM-DD` (UTC), optionally followed by `THH:mm`, `:ss` and `.sss`
/// (any number of digits; milliseconds are kept) and `Z` or `±HH:mm`.
///
/// A time without an offset is read as UTC. JavaScript reads it as local
/// time, so the two differ by the time zone's offset (at most 14 hours).
///
/// That format is all that both JavaScript engines agree on. Engines also
/// accept other forms, differently from each other; those count as invalid
/// here. Still has only ever written `toISOString()` output.
pub fn parse_iso(text: &str) -> Option<i64> {
    let mut p = Parser(text.as_bytes());
    let year = match p.peek() {
        Some(b'+') | Some(b'-') => {
            let negative = p.next() == Some(b'-');
            let digits = p.digits(6)?;
            if negative && digits == 0 {
                return None;
            }
            if negative {
                -digits
            } else {
                digits
            }
        }
        _ => p.digits(4)?,
    };
    let (mut month, mut day) = (1, 1);
    if p.eat(b'-') {
        month = p.digits(2)?;
        if p.eat(b'-') {
            day = p.digits(2)?;
        }
    }
    if !(1..=12).contains(&month) || day < 1 || day > days_in_month(year, month) {
        return None;
    }
    let mut time = 0;
    if p.eat(b'T') {
        let hour = p.digits(2)?;
        p.expect(b':')?;
        let minute = p.digits(2)?;
        let (mut second, mut millis) = (0, 0);
        if p.eat(b':') {
            second = p.digits(2)?;
            if p.eat(b'.') {
                let start = p.0.len();
                while matches!(p.peek(), Some(b'0'..=b'9')) {
                    let digit = i64::from(p.next()? - b'0');
                    if start - p.0.len() <= 3 {
                        millis = millis * 10 + digit;
                    }
                }
                let read = start - p.0.len();
                if read == 0 {
                    return None;
                }
                for _ in read..3 {
                    millis *= 10;
                }
            }
        }
        let past_midnight = hour == 24 && (minute, second, millis) != (0, 0, 0);
        if hour > 24 || past_midnight || minute > 59 || second > 59 {
            return None;
        }
        time = ((hour * 60 + minute) * 60 + second) * 1000 + millis;
        match p.next() {
            None => {}
            Some(b'Z') => {}
            Some(sign @ (b'+' | b'-')) => {
                let hours = p.digits(2)?;
                p.expect(b':')?;
                let minutes = p.digits(2)?;
                if hours > 23 || minutes > 59 {
                    return None;
                }
                let offset = (hours * 60 + minutes) * 60_000;
                time += if sign == b'+' { -offset } else { offset };
            }
            Some(_) => return None,
        }
    }
    if !p.0.is_empty() {
        return None;
    }
    let ms = days_from_civil(year, month, day) * MS_PER_DAY + time;
    (ms.abs() <= MAX_TIME).then_some(ms)
}

/// `new Date(value).getTime()` for a stored JSON value, or None where
/// JavaScript gets NaN: null is 0, booleans 0 or 1, numbers are truncated,
/// strings are read by `parse_iso`, and lists and objects are invalid.
pub fn js_date_value(value: Option<&Value>) -> Option<i64> {
    match value? {
        Value::Null => Some(0),
        Value::Bool(b) => Some(i64::from(*b)),
        Value::Number(n) => {
            let ms = n.as_f64()?.trunc();
            (ms.abs() <= MAX_TIME as f64).then_some(ms as i64)
        }
        Value::String(s) => parse_iso(s),
        Value::Array(_) | Value::Object(_) => None,
    }
}

struct Parser<'a>(&'a [u8]);

impl Parser<'_> {
    fn peek(&self) -> Option<u8> {
        self.0.first().copied()
    }

    fn next(&mut self) -> Option<u8> {
        let (&first, rest) = self.0.split_first()?;
        self.0 = rest;
        Some(first)
    }

    fn eat(&mut self, byte: u8) -> bool {
        let found = self.peek() == Some(byte);
        if found {
            self.0 = &self.0[1..];
        }
        found
    }

    fn expect(&mut self, byte: u8) -> Option<()> {
        self.eat(byte).then_some(())
    }

    /// Exactly `count` ASCII digits.
    fn digits(&mut self, count: usize) -> Option<i64> {
        let mut value = 0;
        for _ in 0..count {
            match self.next()? {
                d @ b'0'..=b'9' => value = value * 10 + i64::from(d - b'0'),
                _ => return None,
            }
        }
        Some(value)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn writes_times_as_to_iso_string_does() {
        assert_eq!(to_iso(0), "1970-01-01T00:00:00.000Z");
        assert_eq!(to_iso(1_791_460_800_000), "2026-10-08T12:00:00.000Z");
        assert_eq!(to_iso(1_791_460_800_001), "2026-10-08T12:00:00.001Z");
        assert_eq!(to_iso(951_782_400_000), "2000-02-29T00:00:00.000Z");
        assert_eq!(to_iso(-1), "1969-12-31T23:59:59.999Z");
        assert_eq!(to_iso(-62_198_755_200_000), "-000001-01-01T00:00:00.000Z");
        assert_eq!(to_iso(8_640_000_000_000_000), "+275760-09-13T00:00:00.000Z");
    }

    // Expected values from Node's `new Date(text).getTime()` (2026-10-08).
    #[test]
    fn reads_the_iso_format_as_javascript_does() {
        for (text, ms) in [
            ("2026-10-07", 1_791_331_200_000),
            ("2026-10", 1_790_812_800_000),
            ("2026", 1_767_225_600_000),
            ("2026-10-07T12:00Z", 1_791_374_400_000),
            ("2026-10-07T12:00:00Z", 1_791_374_400_000),
            ("2026-10-07T12:00:00.1Z", 1_791_374_400_100),
            ("2026-10-07T12:00:00.123456Z", 1_791_374_400_123),
            ("2026-10-07T12:00:00.000+02:00", 1_791_367_200_000),
            ("2026-10-07T12:00:00.000-02:00", 1_791_381_600_000),
            ("2024-02-29T00:00:00Z", 1_709_164_800_000),
            ("2026-10-07T24:00:00Z", 1_791_417_600_000),
            ("+002026-10-07T00:00:00.000Z", 1_791_331_200_000),
            ("-000001-01-01T00:00:00Z", -62_198_755_200_000),
            ("0000-01-01T00:00:00Z", -62_167_219_200_000),
            ("+275760-09-13T00:00:00.000Z", 8_640_000_000_000_000),
        ] {
            assert_eq!(parse_iso(text), Some(ms), "{text}");
        }
    }

    #[test]
    fn treats_anything_else_as_invalid() {
        for text in [
            "",
            "yesterday",
            "2026-13-01",
            "2026-02-30",
            "2026-10-07T24:00:01Z",
            "2026-10-07T23:60:00Z",
            "2026-10-07T12:00:60Z",
            "-000000-01-01T00:00:00Z",
            "+275760-09-13T00:00:00.001Z",
            "20261007",
            "2026-10-07T12Z",
            "2026-10-07T12:00:00.Z",
            "2026-10-07T12:00:00+02",
            "2026-10-07T12:00:00.000Z ",
            // Forms one engine or another accepts, outside the standard format.
            "Oct 7 2026",
            "2026-1-7",
            " 2026-10-07",
            "2026-10-07 12:00:00Z",
            "2026-10-07T12:00:00+0200",
        ] {
            assert_eq!(parse_iso(text), None, "{text}");
        }
    }

    #[test]
    fn reads_other_json_values_as_new_date_does() {
        assert_eq!(js_date_value(None), None);
        assert_eq!(js_date_value(Some(&json!(null))), Some(0));
        assert_eq!(js_date_value(Some(&json!(true))), Some(1));
        assert_eq!(js_date_value(Some(&json!(1.5))), Some(1));
        assert_eq!(js_date_value(Some(&json!(-1.5))), Some(-1));
        assert_eq!(js_date_value(Some(&json!(9e15))), None);
        assert_eq!(js_date_value(Some(&json!({}))), None);
        assert_eq!(js_date_value(Some(&json!([]))), None);
        assert_eq!(
            js_date_value(Some(&json!("2026-10-07"))),
            Some(1_791_331_200_000)
        );
    }

    #[test]
    fn round_trips_every_day_for_a_few_centuries() {
        let mut ms = days_from_civil(1800, 1, 1) * MS_PER_DAY;
        let end = days_from_civil(2400, 1, 1) * MS_PER_DAY;
        while ms < end {
            assert_eq!(parse_iso(&to_iso(ms)), Some(ms));
            ms += MS_PER_DAY + 3_723_004;
        }
    }
}
