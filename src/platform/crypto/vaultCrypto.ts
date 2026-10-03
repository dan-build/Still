// The vault's crypto, behind key handles. Whoever implements this keeps the
// app key and every Lens key to itself; callers only ever see encrypted blobs
// and refer to Lens keys by Lens id. The app's implementation calls Rust
// (platform/tauri/vaultCrypto.ts); tests use the JS reference one
// (test/reference/libsodiumVaultCrypto.ts).

/**
 * wrong-password: the password didn't open the master key.
 * corrupt: stored data is damaged or in an unknown format.
 * failed: anything else, such as running out of memory for Argon2id.
 * locked: there are no keys; unlock or create a vault first.
 * unknown-lens: no key is held for that Lens id.
 */
export type VaultCryptoErrorCode = 'wrong-password' | 'corrupt' | 'failed' | 'locked' | 'unknown-lens'

/** A crypto failure. The message is the code only, never anything secret. */
export class VaultCryptoError extends Error {
  constructor(readonly code: VaultCryptoErrorCode) {
    super(code)
  }
}

export interface WrappedLensKey {
  id: string
  encryptedMasterKey: string
}

export interface VaultCrypto {
  /** Makes a new app key and keeps it. Returns it wrapped by the password, with the salt. */
  createVault(password: string): Promise<{ encryptedMasterKey: string; salt: string }>
  /**
   * Opens the app key, then each Lens key, and keeps those that open. Returns
   * one entry per Lens, in order: true if its key opened. Replaces any keys
   * held before.
   */
  unlock(encryptedMasterKey: string, salt: string, password: string, lenses: WrappedLensKey[]): Promise<boolean[]>
  /** Makes a key for a new Lens and keeps it. Returns it wrapped by the app key. */
  newLensKey(lensId: string): Promise<string>
  encryptItem(lensId: string, plaintext: string): Promise<string>
  decryptItem(lensId: string, encryptedValue: string): Promise<string>
  /** Forgets and zeroes every key. */
  lock(): Promise<void>
}
