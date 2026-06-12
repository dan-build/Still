'use client'

const KDF_CONTEXT = 'StillSec'

let sodiumPromise: Promise<any> | null = null

async function getSodium() {
  if (!sodiumPromise) {
    sodiumPromise = import('libsodium-wrappers-sumo').then(async (mod) => {
      const s = mod.default || mod
      await s.ready
      return s
    })
  }

  return sodiumPromise
}

// ==================== PASSWORD-BASED KEY DERIVATION (Argon2id) ====================

/**
 * Derives a 32-byte key from a password using Argon2id (via libsodium)
 * This is the recommended way for maximum security in this project.
 */
export async function deriveKeyFromPassword(
  password: string,
  salt: Uint8Array
): Promise<Uint8Array> {
  const s = await getSodium()

  return s.crypto_pwhash(
    32,                                           // key length (32 bytes)
    password,
    salt,
    s.crypto_pwhash_OPSLIMIT_SENSITIVE,           // High security parameters
    s.crypto_pwhash_MEMLIMIT_SENSITIVE,
    s.crypto_pwhash_ALG_ARGON2ID13
  )
}

// ==================== MASTER KEY ENCRYPTION / DECRYPTION ====================

export async function encryptMasterKey(
  masterKey: Uint8Array,
  password: string
): Promise<{ encryptedMasterKey: string; salt: string }> {
  const s = await getSodium()
  const salt = s.randombytes_buf(16) // 16-byte salt

  const derivedKey = await deriveKeyFromPassword(password, salt)

  const nonce = s.randombytes_buf(s.crypto_aead_xchacha20poly1305_ietf_NPUBBYTES)
  const ciphertext = s.crypto_aead_xchacha20poly1305_ietf_encrypt(
    masterKey,
    null,
    null,
    nonce,
    derivedKey
  )

  const combined = new Uint8Array(1 + nonce.length + ciphertext.length)
  combined[0] = 1
  combined.set(nonce, 1)
  combined.set(ciphertext, 1 + nonce.length)

  return {
    encryptedMasterKey: s.to_base64(combined, s.base64_variants.ORIGINAL),
    salt: s.to_base64(salt, s.base64_variants.ORIGINAL),
  }
}

export async function decryptMasterKey(
  encryptedMasterKey: string,
  password: string,
  saltBase64: string
): Promise<Uint8Array> {
  const s = await getSodium()
  const salt = s.from_base64(saltBase64, s.base64_variants.ORIGINAL)
  const combined = s.from_base64(encryptedMasterKey, s.base64_variants.ORIGINAL)

  const derivedKey = await deriveKeyFromPassword(password, salt)

  const nonce = combined.slice(1, 1 + s.crypto_aead_xchacha20poly1305_ietf_NPUBBYTES)
  const ciphertext = combined.slice(1 + s.crypto_aead_xchacha20poly1305_ietf_NPUBBYTES)

  const decrypted = s.crypto_aead_xchacha20poly1305_ietf_decrypt(
    null,
    ciphertext,
    null,
    nonce,
    derivedKey
  )

  return decrypted
}

// ==================== EXISTING FUNCTIONS (unchanged) ====================

export async function generateMasterKey(): Promise<Uint8Array> {
  const s = await getSodium()
  return s.randombytes_buf(32)
}

export async function encrypt(
  plaintext: string,
  masterKey: Uint8Array
): Promise<string> {
  const s = await getSodium()

  if (!plaintext?.trim()) {
    throw new Error('Plaintext required')
  }

  if (!(masterKey instanceof Uint8Array)) {
    throw new Error('Master key must be Uint8Array')
  }

  if (masterKey.length !== 32) {
    throw new Error('Master key must be 32 bytes')
  }

  // Force valid unsigned uint32
  const subkeyId = BigInt(s.randombytes_random())

  const subKey = s.crypto_kdf_derive_from_key(
    32,
    subkeyId,
    KDF_CONTEXT,
    masterKey
  )
  const nonce = s.randombytes_buf(s.crypto_aead_xchacha20poly1305_ietf_NPUBBYTES)
  const message = s.from_string(plaintext)

  const ciphertext = s.crypto_aead_xchacha20poly1305_ietf_encrypt(
    message,
    null,
    null,
    nonce,
    subKey
  )

  const combined = new Uint8Array(1 + 4 + nonce.length + ciphertext.length)
  combined[0] = 1
  new DataView(combined.buffer).setUint32(
  1,
  Number(subkeyId),
  true
)
  combined.set(nonce, 5)
  combined.set(ciphertext, 5 + nonce.length)

  return s.to_base64(combined, s.base64_variants.ORIGINAL)
}

export async function decrypt(
  encoded: string,
  masterKey: Uint8Array
): Promise<string> {
  const s = await getSodium()

  if (!(masterKey instanceof Uint8Array)) {
  throw new Error('Master key must be Uint8Array')
}

  const combined = s.from_base64(encoded, s.base64_variants.ORIGINAL)
  const version = combined[0]

  if (version !== 1) throw new Error(`Unsupported version: ${version}`)

  const view = new DataView(combined.buffer)
  const subkeyId = BigInt(view.getUint32(1, true))
  const nonceStart = 5
  const nonce = combined.slice(nonceStart, nonceStart + s.crypto_aead_xchacha20poly1305_ietf_NPUBBYTES)
  const ciphertext = combined.slice(nonceStart + s.crypto_aead_xchacha20poly1305_ietf_NPUBBYTES)

  const subKey = s.crypto_kdf_derive_from_key(32, subkeyId, KDF_CONTEXT, masterKey)

  const decrypted = s.crypto_aead_xchacha20poly1305_ietf_decrypt(
    null,
    ciphertext,
    null,
    nonce,
    subKey
  )

  return s.to_string(decrypted)
}

// Base64 helpers
export function uint8ArrayToBase64(bytes: Uint8Array): string {
  let binary = ''
  bytes.forEach(b => binary += String.fromCharCode(b))
  return btoa(binary)
}

export function base64ToUint8Array(base64: string): Uint8Array {
  const binary = atob(base64)
  return Uint8Array.from(binary, c => c.charCodeAt(0))
}


// ==================== LENS KEY PROTECTION (using app masterKey) ====================

/**
 * Encrypts a lens master key using the app-level masterKey.
 * Returns base64 string safe to store in localStorage.
 */
export async function encryptLensMasterKey(
  lensMasterKey: Uint8Array,
  appMasterKey: Uint8Array
): Promise<string> {
  const s = await getSodium()

  const nonce = s.randombytes_buf(s.crypto_aead_xchacha20poly1305_ietf_NPUBBYTES)
  const ciphertext = s.crypto_aead_xchacha20poly1305_ietf_encrypt(
    lensMasterKey,
    null,
    null,
    nonce,
    appMasterKey
  )

  const combined = new Uint8Array(1 + nonce.length + ciphertext.length)
  combined[0] = 1
  combined.set(nonce, 1)
  combined.set(ciphertext, 1 + nonce.length)

  return s.to_base64(combined, s.base64_variants.ORIGINAL)
}

/**
 * Decrypts a stored lens master key using the app-level masterKey.
 */
export async function decryptLensMasterKey(
  encryptedLensKey: string,
  appMasterKey: Uint8Array
): Promise<Uint8Array> {
  const s = await getSodium()
  const combined = s.from_base64(encryptedLensKey, s.base64_variants.ORIGINAL)

  const version = combined[0]
  if (version !== 1) throw new Error('Unsupported lens key version')

  const nonce = combined.slice(1, 1 + s.crypto_aead_xchacha20poly1305_ietf_NPUBBYTES)
  const ciphertext = combined.slice(1 + s.crypto_aead_xchacha20poly1305_ietf_NPUBBYTES)

  const decrypted = s.crypto_aead_xchacha20poly1305_ietf_decrypt(
    null,
    ciphertext,
    null,
    nonce,
    appMasterKey
  )

  return decrypted
}