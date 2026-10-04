import { afterEach, describe, expect, it, vi } from 'vitest'
import { VaultCryptoError } from '@/platform/crypto/vaultCrypto'

const invoke = vi.fn()
vi.mock('@tauri-apps/api/core', () => ({ invoke: (...args: unknown[]) => invoke(...args) }))

import { createTauriVaultCrypto } from './vaultCrypto'

const crypto = createTauriVaultCrypto()

afterEach(() => invoke.mockReset())

describe('the Tauri VaultCrypto', () => {
  // The argument names must match the Rust commands, which Tauri reads in camelCase.
  it('calls each command with the arguments Rust expects', async () => {
    invoke.mockResolvedValue('ok')
    const lenses = [{ id: 'a', encryptedMasterKey: 'k' }]
    await crypto.createVault('pw')
    await crypto.unlock('mk', 'salt', 'pw', lenses)
    await crypto.newLensKey('a')
    await crypto.encryptItem('a', '  v  ')
    await crypto.decryptItem('a', 'blob')
    await crypto.copyItem('a', 'blob')
    await crypto.lock()
    expect(invoke.mock.calls).toEqual([
      ['vault_create', { password: 'pw' }],
      ['vault_unlock', { encryptedMasterKey: 'mk', salt: 'salt', password: 'pw', lenses }],
      ['lens_new_key', { lensId: 'a' }],
      ['item_encrypt', { lensId: 'a', plaintext: '  v  ' }],
      ['item_decrypt', { lensId: 'a', encryptedValue: 'blob' }],
      ['item_copy', { lensId: 'a', encryptedValue: 'blob' }],
      ['vault_lock', undefined],
    ])
  })

  it('passes results through unchanged', async () => {
    invoke.mockResolvedValueOnce({ encryptedMasterKey: 'mk', salt: 's' }).mockResolvedValueOnce([true, false])
    expect(await crypto.createVault('pw')).toEqual({ encryptedMasterKey: 'mk', salt: 's' })
    expect(await crypto.unlock('mk', 's', 'pw', [])).toEqual([true, false])
  })

  for (const code of ['wrong-password', 'corrupt', 'failed', 'locked', 'unknown-lens'] as const) {
    it(`turns the Rust error "${code}" into a VaultCryptoError`, async () => {
      invoke.mockRejectedValue(code)
      await expect(crypto.decryptItem('a', 'blob')).rejects.toEqual(new VaultCryptoError(code))
    })
  }

  it('treats any other rejection, such as a refused command, as failed', async () => {
    invoke.mockRejectedValue('vault_unlock not allowed. Permissions associated with this command: allow-vault-unlock')
    const error = await crypto.unlock('mk', 's', 'pw', []).catch((e) => e)
    expect(error).toBeInstanceOf(VaultCryptoError)
    expect(error.code).toBe('failed')
    expect(error.message).toBe('failed')
  })
})
