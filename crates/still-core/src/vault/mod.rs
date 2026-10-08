//! The vault: the stored Lens lists and every change to them, as the
//! TypeScript backend (src/platform/storage/backend.ts) did it. Replays
//! fixtures/vault-behaviour-v1 to prove it.

pub mod backend;
pub mod format;
pub mod json;
pub mod model;
pub mod time;
