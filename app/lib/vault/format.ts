// Shape checks for the v1 stored format, done before any crypto so that
// damaged data is reported as damaged rather than as a wrong password.
// crypto.ts itself is unchanged (it doesn't check the master key's version byte).

const NONCE_BYTES = 24
const KEY_BYTES = 32
const TAG_BYTES = 16
const SALT_BYTES = 16
export const V1_KEY_BLOB_BYTES = 1 + NONCE_BYTES + KEY_BYTES + TAG_BYTES

/** Standard, padded base64 (libsodium's ORIGINAL variant), or null if it isn't that. */
export function decodeBase64(value: string): Uint8Array | null {
  if (value.length % 4 !== 0 || !/^[A-Za-z0-9+/]*={0,2}$/.test(value)) return null
  try {
    const binary = atob(value)
    return Uint8Array.from(binary, (c) => c.charCodeAt(0))
  } catch {
    return null
  }
}

/** Whether the stored master key and salt have the v1 shape: version 1, 73 bytes, 16-byte salt. */
export function isV1MasterKey(encryptedMasterKey: string, salt: string): boolean {
  const blob = decodeBase64(encryptedMasterKey)
  const saltBytes = decodeBase64(salt)
  return blob !== null && blob.length === V1_KEY_BLOB_BYTES && blob[0] === 1 && saltBytes?.length === SALT_BYTES
}

/** libsodium's message when authentication fails, i.e. the key (here: the password) is wrong. */
export const AUTH_FAILURE_MESSAGE = 'ciphertext cannot be decrypted using that key'
