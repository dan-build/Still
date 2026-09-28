import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import {
  addLens,
  deleteLensForever,
  forgetLens,
  parseLensList,
  purgeExpired,
  restoreLens,
  serializeLensList,
  setItems,
  VaultDataError,
} from './model'
import type { PersistedLens, VaultLists } from './types'

const lens = (id: string, extra: Partial<PersistedLens> = {}): PersistedLens => ({
  id,
  name: `Lens ${id}`,
  createdAt: '2026-01-01T00:00:00.000Z',
  itemCount: 0,
  encryptedMasterKey: `wrapped-${id}`,
  items: [],
  ...extra,
})

const NOW = new Date('2026-09-28T12:00:00.000Z')
const daysAgo = (days: number) => new Date(NOW.getTime() - days * 24 * 60 * 60 * 1000).toISOString()

describe('parseLensList / serializeLensList', () => {
  it('treats a missing list as empty', () => {
    expect(parseLensList(null)).toEqual([])
  })

  it('rejects stored data that is not a JSON list', () => {
    expect(() => parseLensList('{not json')).toThrow(VaultDataError)
    expect(() => parseLensList('{"id":"x"}')).toThrow(VaultDataError)
  })

  for (const fixture of ['vault-v1', 'vault-v1-real']) {
    it(`round-trips the ${fixture} fixture byte for byte`, () => {
      const vault = JSON.parse(readFileSync(new URL(`../../../fixtures/${fixture}/vault.json`, import.meta.url), 'utf8'))
      for (const key of ['still-lenses', 'still-recycle-bin']) {
        expect(serializeLensList(parseLensList(vault[key]))).toBe(vault[key])
      }
    })
  }

  it('keeps fields it does not know about', () => {
    const raw = JSON.stringify([{ ...lens('a'), futureField: 42 }])
    expect(serializeLensList(parseLensList(raw))).toBe(raw)
  })
})

describe('mutations', () => {
  const base: VaultLists = { lenses: [lens('a'), lens('b')], bin: [lens('z', { deletedAt: daysAgo(1) })] }

  it('adds a new Lens first', () => {
    expect(addLens(base, lens('new')).lenses.map((l) => l.id)).toEqual(['new', 'a', 'b'])
  })

  it('sets items and keeps itemCount in step', () => {
    const items = [{ id: 'i1', label: 'L', type: 'password' as const, encryptedValue: 'blob' }]
    const next = setItems(base, 'b', items)
    expect(next.lenses.find((l) => l.id === 'b')).toMatchObject({ items, itemCount: 1 })
    expect(next.lenses.find((l) => l.id === 'a')).toBe(base.lenses[0])
  })

  it('forgets a Lens into the front of the bin with a deletedAt time', () => {
    const next = forgetLens(base, 'a', NOW)
    expect(next.lenses.map((l) => l.id)).toEqual(['b'])
    expect(next.bin.map((l) => l.id)).toEqual(['a', 'z'])
    expect(next.bin[0].deletedAt).toBe(NOW.toISOString())
  })

  it('restores a Lens to the front of the list without deletedAt', () => {
    const next = restoreLens(base, 'z')
    expect(next.lenses.map((l) => l.id)).toEqual(['z', 'a', 'b'])
    expect(next.lenses[0]).not.toHaveProperty('deletedAt')
    expect(next.bin).toEqual([])
  })

  it('deletes a bin entry for good', () => {
    expect(deleteLensForever(base, 'z').bin).toEqual([])
  })

  it('ignores unknown ids', () => {
    expect(forgetLens(base, 'nope', NOW)).toBe(base)
    expect(restoreLens(base, 'nope')).toBe(base)
  })

  it('never changes its input', () => {
    const snapshot = JSON.stringify(base)
    addLens(base, lens('new'))
    setItems(base, 'a', [])
    forgetLens(base, 'a', NOW)
    restoreLens(base, 'z')
    deleteLensForever(base, 'z')
    purgeExpired(base, NOW)
    expect(JSON.stringify(base)).toBe(snapshot)
  })
})

describe('purgeExpired', () => {
  it('keeps entries deleted within 7 days and removes older ones', () => {
    const state: VaultLists = {
      lenses: [],
      bin: [lens('recent', { deletedAt: daysAgo(6.9) }), lens('old', { deletedAt: daysAgo(7.1) })],
    }
    expect(purgeExpired(state, NOW).bin.map((l) => l.id)).toEqual(['recent'])
  })

  // Same rule as v0.1.0: an entry without a valid deletedAt counts as expired.
  it('removes bin entries without a valid deletedAt', () => {
    const state: VaultLists = { lenses: [], bin: [lens('none'), lens('bad', { deletedAt: 'not a date' })] }
    expect(purgeExpired(state, NOW).bin).toEqual([])
  })
})
