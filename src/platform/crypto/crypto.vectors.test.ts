// Fixed-input v1 vectors (fixtures/vault-v1/vectors.json). The app's crypto
// must decrypt every vector, and libsodium must still produce the same bytes
// from the same fixed inputs. The Rust port must pass the same vectors.

import { readFileSync } from 'node:fs'
import { beforeAll, describe, expect, it } from 'vitest'
import { decrypt, decryptLensMasterKey, decryptMasterKey, deriveKeyFromPassword } from './crypto'

const vectors = JSON.parse(
  readFileSync(new URL('../../../fixtures/vault-v1/vectors.json', import.meta.url), 'utf8'),
)

const fromHex = (value: string) => new Uint8Array(Buffer.from(value, 'hex'))
const fromB64 = (value: string) => new Uint8Array(Buffer.from(value, 'base64'))
const toHex = (data: Uint8Array) => Buffer.from(data).toString('hex')

let s: any

beforeAll(async () => {
  const mod: any = await import('libsodium-wrappers-sumo')
  s = mod.default ?? mod
  await s.ready
})

describe('v1 vectors: Argon2id', () => {
  it('uses libsodium SENSITIVE limits for argon2id13', () => {
    expect(vectors.argon2.params).toEqual({
      algorithm: 'argon2id13',
      opslimit: s.crypto_pwhash_OPSLIMIT_SENSITIVE,
      memlimit: s.crypto_pwhash_MEMLIMIT_SENSITIVE,
      outputBytes: 32,
    })
    expect(vectors.argon2.params.opslimit).toBe(4)
    expect(vectors.argon2.params.memlimit).toBe(1024 * 1024 * 1024)
  })

  for (const vector of vectors.argon2.vectors) {
    it(`derives the recorded key for password ${JSON.stringify(vector.password)}`, async () => {
      expect(toHex(new TextEncoder().encode(vector.password))).toBe(vector.passwordUtf8)
      const key = await deriveKeyFromPassword(vector.password, fromHex(vector.salt))
      expect(toHex(key)).toBe(vector.key)
    })
  }
})

describe('v1 vectors: key blobs', () => {
  it('decryptMasterKey opens the master-key blob', async () => {
    const { blob, password, salt, masterKey } = vectors.masterKeyBlob
    expect(toHex(await decryptMasterKey(blob, password, salt))).toBe(masterKey)
  })

  it('decryptLensMasterKey opens the wrapped Lens-key blob', async () => {
    const { blob, appMasterKey, lensKey } = vectors.lensKeyBlob
    expect(toHex(await decryptLensMasterKey(blob, fromHex(appMasterKey)))).toBe(lensKey)
  })

  it('libsodium reproduces both key blobs from the fixed inputs', () => {
    const wrap = (plaintext: Uint8Array, key: Uint8Array, nonce: Uint8Array) => {
      const ciphertext = s.crypto_aead_xchacha20poly1305_ietf_encrypt(plaintext, null, null, nonce, key)
      return Buffer.concat([Buffer.from([1]), nonce, ciphertext]).toString('base64')
    }
    const master = vectors.masterKeyBlob
    const argonKey = fromHex(vectors.argon2.vectors[1].key)
    expect(wrap(fromHex(master.masterKey), argonKey, fromHex(master.nonce))).toBe(master.blob)

    const lens = vectors.lensKeyBlob
    expect(wrap(fromHex(lens.lensKey), fromHex(lens.appMasterKey), fromHex(lens.nonce))).toBe(lens.blob)
  })
})

describe('v1 vectors: crypto_kdf subkeys', () => {
  it(`derives the recorded subkeys with context ${JSON.stringify(vectors.kdfContext)}`, () => {
    expect(vectors.kdfContext).toBe('StillSec')
    for (const { subkeyId, subkey } of vectors.kdf.vectors) {
      const derived = s.crypto_kdf_derive_from_key(32, BigInt(subkeyId), vectors.kdfContext, fromHex(vectors.kdf.lensKey))
      expect(toHex(derived)).toBe(subkey)
    }
  })
})

describe('v1 vectors: item blobs', () => {
  const lensKey = () => fromHex(vectors.items.lensKey)

  for (const vector of vectors.items.vectors) {
    it(`decrypt opens the item with subkey id ${vector.subkeyId}`, async () => {
      expect(await decrypt(vector.blob, lensKey())).toBe(vector.plaintext)
    })
  }

  it('stores the subkey id as uint32 little-endian, then the nonce', () => {
    for (const vector of vectors.items.vectors) {
      const blob = fromB64(vector.blob)
      expect(blob[0]).toBe(1)
      expect(new DataView(blob.buffer, blob.byteOffset, blob.byteLength).getUint32(1, true)).toBe(vector.subkeyId)
      expect(toHex(blob.slice(5, 29))).toBe(vector.nonce)
    }
  })

  it('libsodium reproduces every item blob from the fixed inputs', () => {
    for (const vector of vectors.items.vectors) {
      const subkey = s.crypto_kdf_derive_from_key(32, BigInt(vector.subkeyId), 'StillSec', lensKey())
      const nonce = fromHex(vector.nonce)
      const ciphertext = s.crypto_aead_xchacha20poly1305_ietf_encrypt(
        s.from_string(vector.plaintext), null, null, nonce, subkey,
      )
      const id = Buffer.alloc(4)
      id.writeUInt32LE(vector.subkeyId)
      expect(Buffer.concat([Buffer.from([1]), id, nonce, ciphertext]).toString('base64')).toBe(vector.blob)
    }
  })
})
