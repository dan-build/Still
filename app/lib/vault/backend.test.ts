import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import * as realCrypto from '../crypto'
import * as fakeCrypto from '../../test/fakeCrypto'
import { MemoryStorage } from '../../test/memoryStorage'
import { createLocalStorageBackend } from './backend'
import { STORAGE_KEYS, type PersistedLens } from './types'

const NOW = new Date('2026-09-28T12:00:00.000Z')
const clock = () => NOW

async function freshVault() {
  const storage = new MemoryStorage()
  const backend = createLocalStorageBackend(storage, fakeCrypto, clock)
  await backend.create('pw-123456')
  return { storage, backend }
}

const storedList = (storage: MemoryStorage, key: string): PersistedLens[] => JSON.parse(storage.getItem(key) ?? '[]')

describe('create, unlock and status', () => {
  it('reports an empty install, then a locked vault', async () => {
    const storage = new MemoryStorage()
    const backend = createLocalStorageBackend(storage, fakeCrypto, clock)
    expect(backend.status()).toBe('empty')

    await backend.create('pw-123456')
    expect(backend.status()).toBe('unlocked')
    expect(storage.getItem(STORAGE_KEYS.hasPin)).toBe('false')

    backend.lock()
    expect(backend.status()).toBe('locked')
  })

  it('unlocks with the right password only', async () => {
    const { storage } = await freshVault()
    const backend = createLocalStorageBackend(storage, fakeCrypto, clock)
    expect(await backend.unlock('wrong')).toEqual({ ok: false, reason: 'wrong-password' })
    expect(backend.status()).toBe('locked')
    expect(await backend.unlock('pw-123456')).toEqual({ ok: true })
    expect(backend.status()).toBe('unlocked')
  })

  it('reports a missing vault on unlock', async () => {
    const backend = createLocalStorageBackend(new MemoryStorage(), fakeCrypto, clock)
    expect(await backend.unlock('x')).toEqual({ ok: false, reason: 'no-vault' })
  })

  it('writes nothing when unlocking', async () => {
    const { storage, backend } = await freshVault()
    const lensId = await backend.createLens('A')
    await backend.addItem(lensId, { label: 'L', type: 'password', value: 'v' })
    const before = new Map(storage.data)
    storage.writes = []

    const reopened = createLocalStorageBackend(storage, fakeCrypto, clock)
    await reopened.unlock('pw-123456')
    expect(storage.writes).toEqual([])
    expect(storage.data).toEqual(before)
  })
})

describe('Lenses and items', () => {
  it('creates a Lens, adds a secret, and reveals it', async () => {
    const { storage, backend } = await freshVault()
    const lensId = await backend.createLens('  Work  ')
    await backend.addItem(lensId, { label: 'GitHub', type: 'key', value: 'ghp-123' })

    expect(backend.view().lenses).toEqual([
      expect.objectContaining({ id: lensId, name: 'Work', itemCount: 1, items: [expect.objectContaining({ label: 'GitHub', type: 'key' })] }),
    ])
    const stored = storedList(storage, STORAGE_KEYS.lenses)[0]
    expect(stored.items[0].encryptedValue).not.toContain('ghp-123')
    expect(await backend.revealItem(lensId, backend.view().lenses[0].items[0].id)).toBe('ghp-123')
  })

  it('never exposes keys or encrypted values in the view', async () => {
    const { backend } = await freshVault()
    const lensId = await backend.createLens('A')
    await backend.addItem(lensId, { label: 'L', type: 'password', value: 'secret' })
    const view = JSON.stringify(backend.view())
    expect(view).not.toContain('encrypted')
    expect(view).not.toContain('secret')
  })

  it('deletes a secret', async () => {
    const { storage, backend } = await freshVault()
    const lensId = await backend.createLens('A')
    await backend.addItem(lensId, { label: 'L', type: 'password', value: 'v' })
    await backend.deleteItem(lensId, backend.view().lenses[0].items[0].id)
    expect(storedList(storage, STORAGE_KEYS.lenses)[0]).toMatchObject({ items: [], itemCount: 0 })
  })

  it('does not re-wrap other Lens keys when one Lens changes', async () => {
    const { storage, backend } = await freshVault()
    const a = await backend.createLens('A')
    await backend.createLens('B')
    const wrappedBefore = storedList(storage, STORAGE_KEYS.lenses).map((l) => l.encryptedMasterKey)
    await backend.addItem(a, { label: 'L', type: 'password', value: 'v' })
    expect(storedList(storage, STORAGE_KEYS.lenses).map((l) => l.encryptedMasterKey)).toEqual(wrappedBefore)
  })

  it('runs changes one at a time, so concurrent changes are all saved', async () => {
    const { storage, backend } = await freshVault()
    const lensId = await backend.createLens('A')
    await Promise.all(
      ['one', 'two', 'three'].map((label) => backend.addItem(lensId, { label, type: 'password', value: label })),
    )
    expect(storedList(storage, STORAGE_KEYS.lenses)[0].items.map((i) => i.label).sort()).toEqual(['one', 'three', 'two'])
  })
})

describe('the recycle bin', () => {
  it('forgets, restores and deletes Lenses for good, saving each step', async () => {
    const { storage, backend } = await freshVault()
    const keep = await backend.createLens('Keep')
    const drop = await backend.createLens('Drop')
    const gone = await backend.createLens('Gone')

    await backend.forgetLens(drop)
    await backend.forgetLens(gone)
    expect(storedList(storage, STORAGE_KEYS.bin).map((l) => l.name)).toEqual(['Gone', 'Drop'])
    expect(storedList(storage, STORAGE_KEYS.bin)[0].deletedAt).toBe(NOW.toISOString())

    await backend.restoreLens(drop)
    expect(storedList(storage, STORAGE_KEYS.lenses).map((l) => l.id)).toEqual([drop, keep])

    await backend.addItem(drop, { label: 'L', type: 'password', value: 'still readable' })
    expect(await backend.revealItem(drop, backend.view().lenses[0].items[0].id)).toBe('still readable')

    await backend.forgetLens(keep)
    await backend.deleteLensForever(gone)
    expect(storedList(storage, STORAGE_KEYS.bin).map((l) => l.name)).toEqual(['Keep'])
  })

  it('saves an empty Lens list when the last Lens is forgotten', async () => {
    const { storage, backend } = await freshVault()
    const only = await backend.createLens('Only')
    await backend.forgetLens(only)
    expect(storage.getItem(STORAGE_KEYS.lenses)).toBe('[]')

    const reopened = createLocalStorageBackend(storage, fakeCrypto, clock)
    await reopened.unlock('pw-123456')
    expect(reopened.view().lenses).toEqual([])
    expect(reopened.view().bin.map((l) => l.name)).toEqual(['Only'])
  })

  it('purges bin entries older than 7 days on unlock and saves that', async () => {
    const { storage, backend } = await freshVault()
    await backend.createLens('Keep')
    const old = await backend.createLens('Old')
    const recent = await backend.createLens('Recent')
    await backend.forgetLens(old)
    await backend.forgetLens(recent)
    const bin = storedList(storage, STORAGE_KEYS.bin)
    bin.find((l) => l.name === 'Old')!.deletedAt = new Date(NOW.getTime() - 8 * 24 * 3600 * 1000).toISOString()
    storage.setItem(STORAGE_KEYS.bin, JSON.stringify(bin))

    const reopened = createLocalStorageBackend(storage, fakeCrypto, clock)
    await reopened.unlock('pw-123456')
    expect(reopened.view().bin.map((l) => l.name)).toEqual(['Recent'])
    expect(storedList(storage, STORAGE_KEYS.bin).map((l) => l.name)).toEqual(['Recent'])
  })
})

describe('golden fixtures with the real crypto', () => {
  for (const fixture of ['vault-v1', 'vault-v1-real']) {
    it(`opens ${fixture} and reveals every secret exactly`, async () => {
      const read = (name: string) =>
        JSON.parse(readFileSync(new URL(`../../../fixtures/${fixture}/${name}`, import.meta.url), 'utf8'))
      const vault = read('vault.json')
      const expected = read('expected.json')
      const storage = new MemoryStorage(vault)
      // A fixed clock inside the recycle window, so the bin entry isn't purged.
      const backend = createLocalStorageBackend(storage, realCrypto, () => new Date('2026-09-28T00:00:00.000Z'))

      expect(await backend.unlock(expected.password)).toEqual({ ok: true })
      const view = backend.view()
      for (const [list, want] of [
        [view.lenses, expected.lenses],
        [view.bin, expected.recycleBin],
      ] as const) {
        expect(list.map((l) => l.id).sort()).toEqual(Object.keys(want).sort())
        for (const lens of list) {
          expect(lens.name).toBe(want[lens.id].name)
          for (const item of lens.items) {
            expect(await backend.revealItem(lens.id, item.id)).toBe(want[lens.id].items[item.id])
          }
        }
      }
      expect(storage.writes).toEqual([])
      expect(Object.fromEntries(storage.data)).toEqual(vault)
    })
  }
})
