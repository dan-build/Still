# Golden v1 vault

A vault generated once by `scripts/generate-golden-vault.mts`, using the app's own `app/lib/crypto.ts`. Everything in it is dummy data, and the password is test-only.

- `vault.json` holds the five localStorage keys and their string values, exactly as the app stores them.
- `expected.json` holds the password and every expected plaintext, keyed by Lens id and item id.

The fixture pins the v1 encrypted format. Every implementation must decrypt it: the current JS code, and later the Rust port.

**Never regenerate or edit these files to make a test pass.** If a test fails, the code has broken compatibility with existing vaults. Adding a new fixture for a new format version is fine, but this one stays as it is.
