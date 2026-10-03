// VaultCrypto on libsodium in the webview: crypto.ts, with the keys kept in
// this closure.

import type * as CryptoModule from './crypto'
import { AUTH_FAILURE_MESSAGE } from '@/features/vault/model/format'
import { VaultCryptoError, type VaultCrypto } from './vaultCrypto'

export type CryptoApi = Pick<
  typeof CryptoModule,
  | 'generateMasterKey'
  | 'encryptMasterKey'
  | 'decryptMasterKey'
  | 'encryptLensMasterKey'
  | 'decryptLensMasterKey'
  | 'encrypt'
  | 'decrypt'
>

export function createLibsodiumVaultCrypto(crypto: CryptoApi): VaultCrypto {
  let appKey: Uint8Array | null = null
  const lensKeys = new Map<string, Uint8Array>()

  function forgetKeys() {
    appKey?.fill(0)
    appKey = null
    for (const key of lensKeys.values()) key.fill(0)
    lensKeys.clear()
  }

  function requireAppKey(): Uint8Array {
    if (!appKey) throw new VaultCryptoError('locked')
    return appKey
  }

  function lensKey(lensId: string): Uint8Array {
    requireAppKey()
    const key = lensKeys.get(lensId)
    if (!key) throw new VaultCryptoError('unknown-lens')
    return key
  }

  return {
    async createVault(password) {
      const key = await crypto.generateMasterKey()
      const wrapped = await crypto.encryptMasterKey(key, password)
      forgetKeys()
      appKey = key
      return wrapped
    },

    async unlock(encryptedMasterKey, salt, password, lenses) {
      let key: Uint8Array
      try {
        key = await crypto.decryptMasterKey(encryptedMasterKey, password, salt)
      } catch (error) {
        const wrongPassword = error instanceof Error && error.message === AUTH_FAILURE_MESSAGE
        throw new VaultCryptoError(wrongPassword ? 'wrong-password' : 'failed')
      }
      forgetKeys()
      appKey = key
      const opened: boolean[] = []
      for (const lens of lenses) {
        try {
          lensKeys.set(lens.id, await crypto.decryptLensMasterKey(lens.encryptedMasterKey, key))
          opened.push(true)
        } catch {
          opened.push(false)
        }
      }
      return opened
    },

    async newLensKey(lensId) {
      const wrappingKey = requireAppKey()
      const key = await crypto.generateMasterKey()
      const wrapped = await crypto.encryptLensMasterKey(key, wrappingKey)
      lensKeys.set(lensId, key)
      return wrapped
    },

    async encryptItem(lensId, plaintext) {
      return crypto.encrypt(plaintext, lensKey(lensId))
    },

    async decryptItem(lensId, encryptedValue) {
      return crypto.decrypt(encryptedValue, lensKey(lensId))
    },

    async lock() {
      forgetKeys()
    },
  }
}
