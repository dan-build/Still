import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { decodeBase64, isV1MasterKey } from './format'

const b64 = (bytes: number[] | Uint8Array) => Buffer.from(Uint8Array.from(bytes)).toString('base64')
const blob = (length: number, version = 1) => b64([version, ...new Array(length - 1).fill(0)])
const salt16 = b64(new Array(16).fill(7))

describe('isV1MasterKey', () => {
  for (const fixture of ['vault-v1', 'vault-v1-real']) {
    it(`accepts the ${fixture} fixture`, () => {
      const vault = JSON.parse(readFileSync(new URL(`../../../../fixtures/${fixture}/vault.json`, import.meta.url), 'utf8'))
      expect(isV1MasterKey(vault['still-encrypted-master-key'], vault['still-salt'])).toBe(true)
    })
  }

  it('rejects damaged shapes', () => {
    expect(isV1MasterKey(blob(73), salt16)).toBe(true)
    expect(isV1MasterKey(blob(73, 2), salt16)).toBe(false)
    expect(isV1MasterKey(blob(72), salt16)).toBe(false)
    expect(isV1MasterKey(blob(40), salt16)).toBe(false)
    expect(isV1MasterKey(blob(73), b64(new Array(15).fill(7)))).toBe(false)
    expect(isV1MasterKey('not base64!', salt16)).toBe(false)
    expect(isV1MasterKey(blob(73).replace(/=+$/, ''), salt16)).toBe(false)
  })
})

describe('decodeBase64', () => {
  it('decodes standard padded base64 only', () => {
    expect(decodeBase64('AAEC')).toEqual(Uint8Array.from([0, 1, 2]))
    expect(decodeBase64('AAE=')).toEqual(Uint8Array.from([0, 1]))
    expect(decodeBase64('AAE')).toBeNull()
    expect(decodeBase64('AA-_')).toBeNull()
  })
})
