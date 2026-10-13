# Golden v2 vault

The golden v1 vault (`fixtures/vault-v1`) in vault format v2 (`docs/vault-format-v2.md`): the same password, the same app key, and the same Lens lists, byte for byte, inside the encrypted body. It was written once by `crates/still-core/examples/generate_v2_vault.rs`, with a fixed salt and fixed nonces, so every byte is pinned. Everything in it is dummy data, and the password is test-only.

- `vault.json` is the v2 file, exactly as v2 writes it.
- `expected.json` is `fixtures/vault-v1/expected.json`: the password and every expected plaintext.
- `vectors.json` holds the parts of the format from fixed keys: the Argon2id settings block, the body key, the wrapped app key, the framed and the sealed body, and the golden vault's password key.

`crates/still-core/tests/golden_v2.rs` opens it, checks the lists equal the v1 fixture's and reveals every secret, and reproduces every vector.

**Never regenerate or edit these files to make a test pass.** If a test fails, the code has broken compatibility with v2 vaults.
