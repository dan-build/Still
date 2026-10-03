// VaultCrypto in Rust: every call is a Tauri command (src-tauri/src/commands.rs),
// and the keys never leave the Rust process. This is the only code that calls
// invoke for the vault.

import { invoke } from '@tauri-apps/api/core'
import { VaultCryptoError, type VaultCrypto, type VaultCryptoErrorCode } from '@/platform/crypto/vaultCrypto'

const CODES: readonly VaultCryptoErrorCode[] = ['wrong-password', 'corrupt', 'failed', 'locked', 'unknown-lens']

/** Rust rejects with a bare code. Anything else (such as a refused command) is a failure. */
function toCryptoError(error: unknown): VaultCryptoError {
  const code = CODES.find((c) => c === error)
  return new VaultCryptoError(code ?? 'failed')
}

async function call<T>(command: string, args?: Record<string, unknown>): Promise<T> {
  try {
    return await invoke<T>(command, args)
  } catch (error) {
    throw toCryptoError(error)
  }
}

export function createTauriVaultCrypto(): VaultCrypto {
  return {
    createVault: (password) => call('vault_create', { password }),
    unlock: (encryptedMasterKey, salt, password, lenses) =>
      call('vault_unlock', { encryptedMasterKey, salt, password, lenses }),
    newLensKey: (lensId) => call('lens_new_key', { lensId }),
    encryptItem: (lensId, plaintext) => call('item_encrypt', { lensId, plaintext }),
    decryptItem: (lensId, encryptedValue) => call('item_decrypt', { lensId, encryptedValue }),
    lock: () => call('vault_lock'),
  }
}
