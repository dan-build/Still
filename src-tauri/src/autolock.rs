//! Auto-lock. The vault locks after 5 minutes without activity, and as soon
//! as the computer is found to have slept.
//!
//! - Idle time is measured on the wall clock, so time asleep counts too.
//! - Sleep shows up as the wall clock running ahead of the monotonic clock,
//!   which stops during sleep (macOS and Linux). A forward jump of the wall
//!   clock for any other reason also locks, which is the safe side.
//!
//! The watcher thread calls `check` about once a second; every vault command
//! and the UI's activity signal call `touch`.

use std::sync::{Mutex, MutexGuard};
use std::time::{Duration, Instant, SystemTime};

use serde::Serialize;

pub const IDLE_TIMEOUT: Duration = Duration::from_secs(5 * 60);
/// How far the wall clock may run ahead of the monotonic one between two ticks
/// before it counts as a sleep. Ticks are a second apart.
const SLEEP_GAP: Duration = Duration::from_secs(15);

/// Why the vault locked itself; sent to the UI.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum Reason {
    Idle,
    Sleep,
}

/// The idle timeout. Debug builds accept STILL_IDLE_SECONDS (at least 5) so
/// auto-lock can be checked by hand; release builds always use 5 minutes.
pub fn idle_timeout() -> Duration {
    idle_timeout_from(
        std::env::var("STILL_IDLE_SECONDS").ok().as_deref(),
        cfg!(debug_assertions),
    )
}

fn idle_timeout_from(setting: Option<&str>, debug_build: bool) -> Duration {
    match setting.and_then(|s| s.parse::<u64>().ok()) {
        Some(seconds) if debug_build => Duration::from_secs(seconds.max(5)),
        _ => IDLE_TIMEOUT,
    }
}

struct State {
    last_activity: SystemTime,
    last_tick: Option<(Instant, SystemTime)>,
}

pub struct AutoLock {
    state: Mutex<State>,
    idle_timeout: Duration,
}

impl AutoLock {
    pub fn new(idle_timeout: Duration) -> Self {
        Self {
            state: Mutex::new(State {
                last_activity: SystemTime::now(),
                last_tick: None,
            }),
            idle_timeout,
        }
    }

    fn state(&self) -> MutexGuard<'_, State> {
        self.state.lock().unwrap_or_else(|p| p.into_inner())
    }

    /// The user did something.
    pub fn touch(&self, now: SystemTime) {
        self.state().last_activity = now;
    }

    /// Whether an unlocked vault should lock now, and why. Always records the
    /// tick, so a sleep while locked isn't mistaken for one later.
    pub fn check(&self, mono: Instant, wall: SystemTime, unlocked: bool) -> Option<Reason> {
        let mut state = self.state();
        let slept = state.last_tick.is_some_and(|(last_mono, last_wall)| {
            let mono_elapsed = mono.saturating_duration_since(last_mono);
            wall.duration_since(last_wall)
                .is_ok_and(|wall_elapsed| wall_elapsed > mono_elapsed + SLEEP_GAP)
        });
        state.last_tick = Some((mono, wall));
        if !unlocked {
            return None;
        }
        if slept {
            return Some(Reason::Sleep);
        }
        let idle = wall.duration_since(state.last_activity).unwrap_or_default();
        (idle >= self.idle_timeout).then_some(Reason::Idle)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const SEC: Duration = Duration::from_secs(1);

    /// A clock pair that ticks once a second; `sleep` advances only the wall clock.
    struct Clock {
        mono: Instant,
        wall: SystemTime,
    }

    impl Clock {
        fn new() -> Self {
            Self {
                mono: Instant::now(),
                wall: SystemTime::now(),
            }
        }
        fn tick(&mut self, lock: &AutoLock, unlocked: bool) -> Option<Reason> {
            self.mono += SEC;
            self.wall += SEC;
            lock.check(self.mono, self.wall, unlocked)
        }
        fn sleep(&mut self, d: Duration) {
            self.wall += d;
        }
    }

    #[test]
    fn locks_after_the_idle_timeout_and_not_before() {
        let mut clock = Clock::new();
        let lock = AutoLock::new(Duration::from_secs(10));
        lock.touch(clock.wall);
        for _ in 0..9 {
            assert_eq!(clock.tick(&lock, true), None);
        }
        assert_eq!(clock.tick(&lock, true), Some(Reason::Idle));
    }

    #[test]
    fn activity_keeps_it_unlocked() {
        let mut clock = Clock::new();
        let lock = AutoLock::new(Duration::from_secs(10));
        for _ in 0..30 {
            lock.touch(clock.wall);
            assert_eq!(clock.tick(&lock, true), None);
        }
    }

    #[test]
    fn locks_at_once_after_even_a_short_sleep() {
        let mut clock = Clock::new();
        let lock = AutoLock::new(IDLE_TIMEOUT);
        lock.touch(clock.wall);
        assert_eq!(clock.tick(&lock, true), None);
        clock.sleep(Duration::from_secs(60));
        assert_eq!(clock.tick(&lock, true), Some(Reason::Sleep));
    }

    #[test]
    fn ignores_sleep_while_locked_and_small_clock_jitter() {
        let mut clock = Clock::new();
        let lock = AutoLock::new(IDLE_TIMEOUT);
        clock.tick(&lock, false);
        clock.sleep(Duration::from_secs(3600));
        assert_eq!(clock.tick(&lock, false), None);
        // Unlocked again: the sleep before doesn't count, and jitter doesn't either.
        lock.touch(clock.wall);
        clock.sleep(Duration::from_secs(3));
        assert_eq!(clock.tick(&lock, true), None);
    }

    #[test]
    fn a_backwards_clock_change_neither_locks_nor_breaks() {
        let mut clock = Clock::new();
        let lock = AutoLock::new(IDLE_TIMEOUT);
        lock.touch(clock.wall);
        clock.tick(&lock, true);
        clock.wall -= Duration::from_secs(3600);
        assert_eq!(clock.tick(&lock, true), None);
    }

    #[test]
    fn only_debug_builds_accept_a_shorter_timeout() {
        assert_eq!(idle_timeout_from(Some("20"), true), Duration::from_secs(20));
        assert_eq!(idle_timeout_from(Some("1"), true), Duration::from_secs(5));
        assert_eq!(idle_timeout_from(Some("20"), false), IDLE_TIMEOUT);
        assert_eq!(idle_timeout_from(Some("nonsense"), true), IDLE_TIMEOUT);
        assert_eq!(idle_timeout_from(None, true), IDLE_TIMEOUT);
    }
}
