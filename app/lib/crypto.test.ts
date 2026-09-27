// Characterisation tests for crypto.ts: they record what the code does today,
// including behaviour the audit flags for change. When a fix changes one of
// these on purpose, update the test in the same commit and say why.

import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import {
  decrypt,
  decryptLensMasterKey,
  decryptMasterKey,
  encrypt,
  encryptLensMasterKey,
  encryptMasterKey,
  generateMasterKey,
} from './crypto'

const vectors = JSON.parse(
  readFileSync(new URL('../../fixtures/vault-v1/vectors.json', import.meta.url), 'utf8'),
)

const bytes = (b64: string) => new Uint8Array(Buffer.from(b64, 'base64'))
const b64 = (data: Uint8Array) => Buffer.from(data).toString('base64')
const withByte = (blob: string, index: number, value: number) => {
  const data = bytes(blob)
  data[index] = value
  return b64(data)
}

describe('generateMasterKey', () => {
  it('returns 32 random bytes', async () => {
    const a = await generateMasterKey()
    const b = await generateMasterKey()
    expect(a).toBeInstanceOf(Uint8Array)
    expect(a.length).toBe(32)
    expect(b64(a)).not.toBe(b64(b))
  })
})

describe('encrypt / decrypt', () => {
  const plaintexts = [
    'sk-test-0123456789abcdef',
    'hunter2-Ünïcødé-密码-🔐',
    'line one\nline two',
    '  leading and trailing whitespace is kept by the crypto layer  \n',
    'y'.repeat(10_000),
  ]

  for (const plaintext of plaintexts) {
    it(`round-trips ${JSON.stringify(plaintext.slice(0, 30))}`, async () => {
      const key = await generateMasterKey()
      expect(await decrypt(await encrypt(plaintext, key), key)).toBe(plaintext)
    })
  }

  it('uses a fresh subkey id and nonce for every encryption', async () => {
    const key = await generateMasterKey()
    const first = bytes(await encrypt('same', key))
    const second = bytes(await encrypt('same', key))
    expect(b64(first.slice(1, 29))).not.toBe(b64(second.slice(1, 29)))
  })

  // Audit B3: the UI trims values, and encrypt() refuses whitespace-only input.
  for (const plaintext of ['', '   ', '\n\t']) {
    it(`currently rejects empty or whitespace-only plaintext ${JSON.stringify(plaintext)}`, async () => {
      await expect(encrypt(plaintext, await generateMasterKey())).rejects.toThrow('Plaintext required')
    })
  }

  it('rejects a key that is not a Uint8Array', async () => {
    const key = Array.from(await generateMasterKey()) as unknown as Uint8Array
    await expect(encrypt('x', key)).rejects.toThrow('Master key must be Uint8Array')
    await expect(decrypt(vectors.items.vectors[0].blob, key)).rejects.toThrow('Master key must be Uint8Array')
  })

  it('rejects a key that is not 32 bytes when encrypting', async () => {
    await expect(encrypt('x', new Uint8Array(16))).rejects.toThrow('Master key must be 32 bytes')
  })

  it('rejects a blob whose version byte is not 1', async () => {
    const { blob } = vectors.items.vectors[0]
    const key = new Uint8Array(Buffer.from(vectors.items.lensKey, 'hex'))
    await expect(decrypt(withByte(blob, 0, 2), key)).rejects.toThrow('Unsupported version: 2')
    await expect(decrypt(withByte(blob, 0, 0), key)).rejects.toThrow('Unsupported version: 0')
  })

  it('rejects the wrong key', async () => {
    const blob = await encrypt('secret', await generateMasterKey())
    await expect(decrypt(blob, await generateMasterKey())).rejects.toThrow()
  })

  // Audit S9: there are no length checks; a truncated blob fails inside libsodium.
  it('rejects a truncated blob', async () => {
    const key = await generateMasterKey()
    const blob = bytes(await encrypt('secret', key))
    await expect(decrypt(b64(blob.slice(0, 1)), key)).rejects.toThrow()
    await expect(decrypt(b64(blob.slice(0, 29)), key)).rejects.toThrow()
  })
})

describe('encryptLensMasterKey / decryptLensMasterKey', () => {
  it('round-trips a Lens key as a 73-byte version-1 blob', async () => {
    const appKey = await generateMasterKey()
    const lensKey = await generateMasterKey()
    const blob = await encryptLensMasterKey(lensKey, appKey)
    expect(bytes(blob).length).toBe(73)
    expect(bytes(blob)[0]).toBe(1)
    expect(b64(await decryptLensMasterKey(blob, appKey))).toBe(b64(lensKey))
  })

  it('uses a fresh nonce every time it wraps the same key', async () => {
    const appKey = await generateMasterKey()
    const lensKey = await generateMasterKey()
    expect(await encryptLensMasterKey(lensKey, appKey)).not.toBe(await encryptLensMasterKey(lensKey, appKey))
  })

  it('rejects a blob whose version byte is not 1', async () => {
    const { blob, appMasterKey } = vectors.lensKeyBlob
    const key = new Uint8Array(Buffer.from(appMasterKey, 'hex'))
    await expect(decryptLensMasterKey(withByte(blob, 0, 2), key)).rejects.toThrow('Unsupported lens key version')
  })

  it('rejects the wrong app key', async () => {
    const blob = await encryptLensMasterKey(await generateMasterKey(), await generateMasterKey())
    await expect(decryptLensMasterKey(blob, await generateMasterKey())).rejects.toThrow()
  })
})

describe('encryptMasterKey / decryptMasterKey', () => {
  it('round-trips the app master key with a fresh 16-byte salt', async () => {
    const masterKey = await generateMasterKey()
    const { encryptedMasterKey, salt } = await encryptMasterKey(masterKey, 'correct horse')
    expect(bytes(salt).length).toBe(16)
    expect(bytes(encryptedMasterKey).length).toBe(73)
    expect(bytes(encryptedMasterKey)[0]).toBe(1)
    expect(b64(await decryptMasterKey(encryptedMasterKey, 'correct horse', salt))).toBe(b64(masterKey))
  })

  // Audit S9: unlike the other two decrypt functions, decryptMasterKey does not
  // check the version byte. Adding the check is safe (only 1 was ever written)
  // and should flip this test.
  it('currently ignores the version byte', async () => {
    const { blob, password, salt, masterKey } = vectors.masterKeyBlob
    const decrypted = await decryptMasterKey(withByte(blob, 0, 2), password, salt)
    expect(Buffer.from(decrypted).toString('hex')).toBe(masterKey)
  })
})
