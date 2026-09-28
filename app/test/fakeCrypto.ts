// A fast stand-in for app/lib/crypto.ts, for UI and vault-layer tests.
//
// Blobs have the real v1 shapes (base64, version byte, 24-byte nonce, 16-byte
// tag, same lengths), so structure checks behave as they do with real data.
// "Encryption" is plain bytes plus a SHA-256 tag, so a blob only opens with
// the right key or password. It mirrors crypto.ts behaviour, including what
// it does not check (decryptMasterKey ignores the version byte).
//
// The real crypto is covered by crypto.golden.test.ts and crypto.vectors.test.ts.

import { createHash, randomBytes } from 'node:crypto'

const NONCE = 24
const TAG = 16

const b64 = (data: Uint8Array) => Buffer.from(data).toString('base64')
const utf8 = (text: string) => new Uint8Array(Buffer.from(text, 'utf8'))

function fromB64(value: string): Uint8Array {
  if (!/^[A-Za-z0-9+/]*={0,2}$/.test(value) || value.length % 4 !== 0) throw new Error('incomplete input')
  return new Uint8Array(Buffer.from(value, 'base64'))
}

function tag(...parts: Uint8Array[]): Uint8Array {
  const hash = createHash('sha256')
  for (const part of parts) hash.update(part)
  return new Uint8Array(hash.digest()).slice(0, TAG)
}

const equal = (a: Uint8Array, b: Uint8Array) => a.length === b.length && a.every((byte, i) => byte === b[i])
const concat = (...parts: Uint8Array[]) => new Uint8Array(Buffer.concat(parts))
const authFailure = () => new Error('wrong secret key for the given ciphertext')

// ---- blob builders (also used by tests to seed storage) ----------------------

export function fakeMasterKeyBlob(masterKey: Uint8Array, password: string, salt: Uint8Array): string {
  return b64(concat(Uint8Array.of(1), new Uint8Array(NONCE), masterKey, tag(utf8(password), salt, masterKey)))
}

export function fakeLensKeyBlob(lensKey: Uint8Array, appKey: Uint8Array): string {
  return b64(concat(Uint8Array.of(1), new Uint8Array(NONCE), lensKey, tag(appKey, lensKey)))
}

export function fakeItemBlob(plaintext: string, lensKey: Uint8Array): string {
  const body = utf8(plaintext)
  return b64(concat(Uint8Array.of(1), new Uint8Array(4), new Uint8Array(NONCE), body, tag(lensKey, body)))
}

/** Reads an item blob's plaintext without its key, for assertions in tests. */
export function fakePlaintext(blob: string): string {
  const data = fromB64(blob)
  return Buffer.from(data.slice(1 + 4 + NONCE, data.length - TAG)).toString('utf8')
}

// ---- the crypto.ts API ------------------------------------------------------

export async function generateMasterKey(): Promise<Uint8Array> {
  return new Uint8Array(randomBytes(32))
}

export async function deriveKeyFromPassword(password: string, salt: Uint8Array): Promise<Uint8Array> {
  return new Uint8Array(createHash('sha256').update(utf8(password)).update(salt).digest())
}

export async function encryptMasterKey(masterKey: Uint8Array, password: string) {
  const salt = new Uint8Array(randomBytes(16))
  return { encryptedMasterKey: fakeMasterKeyBlob(masterKey, password, salt), salt: b64(salt) }
}

export async function decryptMasterKey(encryptedMasterKey: string, password: string, saltBase64: string) {
  const salt = fromB64(saltBase64)
  const data = fromB64(encryptedMasterKey)
  const payload = data.slice(1 + NONCE)
  if (payload.length < TAG) throw new Error('ciphertext is too short')
  const key = payload.slice(0, payload.length - TAG)
  if (!equal(payload.slice(payload.length - TAG), tag(utf8(password), salt, key))) throw authFailure()
  return key
}

export async function encryptLensMasterKey(lensKey: Uint8Array, appMasterKey: Uint8Array): Promise<string> {
  return fakeLensKeyBlob(lensKey, appMasterKey)
}

export async function decryptLensMasterKey(encryptedLensKey: string, appMasterKey: Uint8Array) {
  const data = fromB64(encryptedLensKey)
  if (data[0] !== 1) throw new Error('Unsupported lens key version')
  const payload = data.slice(1 + NONCE)
  if (payload.length < TAG) throw new Error('ciphertext is too short')
  const key = payload.slice(0, payload.length - TAG)
  if (!equal(payload.slice(payload.length - TAG), tag(appMasterKey, key))) throw authFailure()
  return key
}

export async function encrypt(plaintext: string, masterKey: Uint8Array): Promise<string> {
  if (!plaintext?.trim()) throw new Error('Plaintext required')
  if (!(masterKey instanceof Uint8Array)) throw new Error('Master key must be Uint8Array')
  if (masterKey.length !== 32) throw new Error('Master key must be 32 bytes')
  return fakeItemBlob(plaintext, masterKey)
}

export async function decrypt(encoded: string, masterKey: Uint8Array): Promise<string> {
  if (!(masterKey instanceof Uint8Array)) throw new Error('Master key must be Uint8Array')
  const data = fromB64(encoded)
  if (data[0] !== 1) throw new Error(`Unsupported version: ${data[0]}`)
  const body = data.slice(1 + 4 + NONCE, data.length - TAG)
  if (data.length < 1 + 4 + NONCE + TAG || !equal(data.slice(data.length - TAG), tag(masterKey, body))) {
    throw authFailure()
  }
  return Buffer.from(body).toString('utf8')
}

export function uint8ArrayToBase64(bytes: Uint8Array): string {
  return b64(bytes)
}

export function base64ToUint8Array(base64: string): Uint8Array {
  return fromB64(base64)
}
