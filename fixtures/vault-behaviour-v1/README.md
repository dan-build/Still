# Vault backend behaviour, v1

`scenarios.json` records what the TypeScript vault backend (`src/platform/storage/backend.ts`) did at v0.4.0, step by step: creating, unlocking and locking a vault, every change to Lenses and secrets, the Archive and its 7-day purge, failed writes, damaged or unusual stored data, and set-aside. It was written once by `src/platform/storage/backend.behaviour.test.ts` (with `STILL_RECORD_BEHAVIOUR=1`).

The vault backend is now in Rust, and `crates/still-core/tests/behaviour_v1.rs` replays this file on every test run. The TypeScript backend and its recorder were removed once the app used the Rust one; both are in the git history, in the commit "Record the vault backend's behaviour as a replayable fixture".

Any vault backend must replay it and see the same results. The file's own header explains the operations, the aliases, what is checked after each step, and how generated ids and encrypted blobs are masked, so an implementation in another language can replay it without the TypeScript code.

The crypto behind it is a stand-in with real v1 blob shapes, so the file holds no real keys, and every value in it is dummy data.

Two kinds of scenario differ on purpose in the Rust backend:
- `lock-during-changes` (marked `concurrent`): there, Lock waits for a change already under way, then locks.
- `lone-surrogate`: a list that JavaScript could write but that can't be read back byte for byte is refused as unreadable data.

**Never regenerate or edit this file to make a test pass.** If a replay fails, the backend has changed behaviour. A deliberate change needs a new fixture.
