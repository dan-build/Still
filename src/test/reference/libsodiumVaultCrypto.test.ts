import { describe, expect, it } from 'vitest'
import * as fakeCrypto from '@/test/fakeCrypto'
import { createLibsodiumVaultCrypto } from './libsodiumVaultCrypto'
import { VaultCryptoError, type VaultCrypto } from './vaultCrypto'

const code = (promise: Promise<unknown>) =>
  promise.then(
    () => 'resolved',
    (error) => (error instanceof VaultCryptoError ? error.code : `other: ${error}`),
  )

async function created() {
  const crypto = createLibsodiumVaultCrypto(fakeCrypto)
  const master = await crypto.createVault('pw-123456')
  return { crypto, master }
}

const unlock = (crypto: VaultCrypto, master: { encryptedMasterKey: string; salt: string }, password: string, lenses: { id: string; encryptedMasterKey: string }[] = []) =>
  crypto.unlock(master.encryptedMasterKey, master.salt, password, lenses)

describe('the libsodium VaultCrypto', () => {
  it('creates a vault, makes Lens keys, and round-trips a secret exactly', async () => {
    const { crypto } = await created()
    await crypto.newLensKey('a')
    const blob = await crypto.encryptItem('a', '  spaced\nout  ')
    expect(blob).not.toContain('spaced')
    expect(await crypto.decryptItem('a', blob)).toBe('  spaced\nout  ')
  })

  it('unlocks with the right password, reporting which Lens keys opened, in order', async () => {
    const { crypto, master } = await created()
    const wrapped = await crypto.newLensKey('a')
    const blob = await crypto.encryptItem('a', 'v')
    const foreign = fakeCrypto.fakeLensKeyBlob(new Uint8Array(32).fill(9), new Uint8Array(32).fill(8))

    const reopened = createLibsodiumVaultCrypto(fakeCrypto)
    expect(await code(unlock(reopened, master, 'wrong'))).toBe('wrong-password')
    expect(await unlock(reopened, master, 'pw-123456', [{ id: 'x', encryptedMasterKey: foreign }, { id: 'a', encryptedMasterKey: wrapped }])).toEqual([false, true])
    expect(await reopened.decryptItem('a', blob)).toBe('v')
    expect(await code(reopened.decryptItem('x', blob))).toBe('unknown-lens')
  })

  it('reports other unlock failures as failed, not a wrong password', async () => {
    const { master } = await created()
    const outOfMemory = createLibsodiumVaultCrypto({ ...fakeCrypto, decryptMasterKey: async () => { throw new RangeError('Cannot enlarge memory') } })
    expect(await code(unlock(outOfMemory, master, 'pw-123456'))).toBe('failed')
  })

  it('refuses everything while locked', async () => {
    const crypto = createLibsodiumVaultCrypto(fakeCrypto)
    expect(await code(crypto.newLensKey('a'))).toBe('locked')
    expect(await code(crypto.encryptItem('a', 'v'))).toBe('locked')
    expect(await code(crypto.decryptItem('a', 'blob'))).toBe('locked')
  })

  it('zeroes every key on lock, and refuses afterwards', async () => {
    const seen: Uint8Array[] = []
    const crypto = createLibsodiumVaultCrypto({
      ...fakeCrypto,
      encryptLensMasterKey: async (lensKey: Uint8Array, appKey: Uint8Array) => {
        seen.push(lensKey, appKey)
        return fakeCrypto.encryptLensMasterKey(lensKey, appKey)
      },
    })
    await crypto.createVault('pw-123456')
    await crypto.newLensKey('a')
    await crypto.newLensKey('b')
    expect(seen.length).toBe(4)
    expect(seen.every((key) => key.some((byte) => byte !== 0))).toBe(true)

    await crypto.lock()
    expect(seen.every((key) => key.every((byte) => byte === 0))).toBe(true)
    expect(await code(crypto.encryptItem('a', 'v'))).toBe('locked')
  })
})
