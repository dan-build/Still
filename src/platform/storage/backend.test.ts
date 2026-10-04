import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import * as realCrypto from '@/test/reference/crypto'
import * as fakeCrypto from '@/test/fakeCrypto'
import { MemoryStorage } from '@/test/memoryStorage'
import { createLibsodiumVaultCrypto, type CryptoApi } from '@/test/reference/libsodiumVaultCrypto'
import { VaultCryptoError, type VaultCrypto } from '@/platform/crypto/vaultCrypto'
import { createVaultBackend, VaultLockedError, VaultWriteError } from './backend'
import { STORAGE_KEYS, type PersistedLens } from '@/features/vault/model/types'

const NOW = new Date('2026-09-28T12:00:00.000Z')
const clock = () => NOW

// The libsodium VaultCrypto on fast fake crypto, or on the given crypto.
const vaultCrypto = (api: CryptoApi = fakeCrypto) => createLibsodiumVaultCrypto(api)

async function freshVault() {
  const storage = new MemoryStorage()
  const backend = createVaultBackend(storage, vaultCrypto(), clock)
  await backend.create('pw-123456')
  return { storage, backend }
}

const storedList = (storage: MemoryStorage, key: string): PersistedLens[] => JSON.parse(storage.getItem(key) ?? '[]')

describe('create, unlock and status', () => {
  it('reports an empty install, then a locked vault', async () => {
    const storage = new MemoryStorage()
    const backend = createVaultBackend(storage, vaultCrypto(), clock)
    expect(backend.status()).toBe('empty')

    await backend.create('pw-123456')
    expect(backend.status()).toBe('unlocked')
    expect(storage.getItem(STORAGE_KEYS.hasPin)).toBe('false')

    await backend.lock()
    expect(backend.status()).toBe('locked')
  })

  it('unlocks with the right password only', async () => {
    const { storage } = await freshVault()
    const backend = createVaultBackend(storage, vaultCrypto(), clock)
    expect(await backend.unlock('wrong')).toEqual({ ok: false, reason: 'wrong-password' })
    expect(backend.status()).toBe('locked')
    expect(await backend.unlock('pw-123456')).toEqual({ ok: true })
    expect(backend.status()).toBe('unlocked')
  })

  it('reports damaged vault data as unreadable, before trying the password', async () => {
    const { storage } = await freshVault()
    const blob = Buffer.from(storage.getItem(STORAGE_KEYS.masterKey)!, 'base64')
    blob[0] = 2
    storage.setItem(STORAGE_KEYS.masterKey, blob.toString('base64'))
    const reopened = createVaultBackend(storage, vaultCrypto(), clock)
    expect(await reopened.unlock('pw-123456')).toEqual({ ok: false, reason: 'unreadable-data' })

    storage.setItem(STORAGE_KEYS.masterKey, blob.subarray(0, 40).toString('base64'))
    expect(await reopened.unlock('pw-123456')).toEqual({ ok: false, reason: 'unreadable-data' })
  })

  it('reports other failures (such as running out of memory) as failed, not a wrong password', async () => {
    const { storage } = await freshVault()
    const outOfMemory = { ...fakeCrypto, decryptMasterKey: async () => { throw new RangeError('Cannot enlarge memory') } }
    const reopened = createVaultBackend(storage, vaultCrypto(outOfMemory), clock)
    expect(await reopened.unlock('pw-123456')).toEqual({ ok: false, reason: 'failed' })
  })

  it('reports a missing vault on unlock', async () => {
    const backend = createVaultBackend(new MemoryStorage(), vaultCrypto(), clock)
    expect(await backend.unlock('x')).toEqual({ ok: false, reason: 'no-vault' })
  })

  it('writes nothing when unlocking', async () => {
    const { storage, backend } = await freshVault()
    const lensId = await backend.createLens('A')
    await backend.addItem(lensId, { label: 'L', type: 'password', value: 'v' })
    const before = new Map(storage.data)
    storage.writes = []

    const reopened = createVaultBackend(storage, vaultCrypto(), clock)
    await reopened.unlock('pw-123456')
    expect(storage.writes).toEqual([])
    expect(storage.data).toEqual(before)
  })
})

describe('what the backend asks of the crypto', () => {
  // A VaultCrypto whose unlock fails with the given error, or opens the listed entries.
  function stub(unlock: VaultCrypto['unlock'], log: string[] = []): VaultCrypto {
    const base = vaultCrypto()
    return { ...base, unlock, newLensKey: async () => 'k-new', lock: async () => { log.push('lock') } }
  }

  it('reports corrupt data from the crypto as unreadable, and anything else as failed', async () => {
    const { storage } = await freshVault()
    const corrupt = stub(async () => { throw new VaultCryptoError('corrupt') })
    expect(await createVaultBackend(storage, corrupt, clock).unlock('pw-123456')).toEqual({ ok: false, reason: 'unreadable-data' })
    const odd = stub(async () => { throw new TypeError('IPC broke') })
    expect(await createVaultBackend(storage, odd, clock).unlock('pw-123456')).toEqual({ ok: false, reason: 'failed' })
  })

  it('passes every stored Lens to unlock, Lenses then bin, and keeps an entry that did not open as stored', async () => {
    const { storage } = await freshVault()
    // v0.1.0 could leave one Lens in both lists. Here its list copy fails to
    // open and has no items field; it must stay exactly as stored.
    const unopened = { id: 'twice', name: 'Twice', createdAt: '2026-01-01T00:00:00.000Z', itemCount: 0, encryptedMasterKey: 'k-list' }
    const opened = { ...unopened, encryptedMasterKey: 'k-bin', items: [], deletedAt: NOW.toISOString() }
    storage.setItem(STORAGE_KEYS.lenses, JSON.stringify([unopened]))
    storage.setItem(STORAGE_KEYS.bin, JSON.stringify([opened]))
    const seen: unknown[] = []
    const backend = createVaultBackend(storage, stub(async (_b, _s, _p, lenses) => { seen.push(lenses); return [false, true] }), clock)

    expect(await backend.unlock('pw-123456')).toEqual({ ok: true })
    expect(seen).toEqual([[{ id: 'twice', encryptedMasterKey: 'k-list' }, { id: 'twice', encryptedMasterKey: 'k-bin' }]])
    await backend.createLens('New')
    expect(storedList(storage, STORAGE_KEYS.lenses).find((l) => l.encryptedMasterKey === 'k-list')).toEqual(unopened)
  })

  it('hides everything at once on Lock, then asks the crypto to forget its keys', async () => {
    const log: string[] = []
    const { storage } = await freshVault()
    const backend = createVaultBackend(storage, stub(async () => [], log), clock)
    await backend.unlock('pw-123456')
    const locking = backend.lock()
    expect(backend.status()).toBe('locked')
    await locking
    expect(log).toEqual(['lock'])
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

  it('copies a secret through the crypto, without returning it', async () => {
    const copied: string[] = []
    const storage = new MemoryStorage()
    const backend = createVaultBackend(storage, createLibsodiumVaultCrypto(fakeCrypto, (t) => copied.push(t)), clock)
    await backend.create('pw-123456')
    const lensId = await backend.createLens('A')
    await backend.addItem(lensId, { label: 'L', type: 'password', value: '  exact\nvalue ' })
    expect(await backend.copyItem(lensId, backend.view().lenses[0].items[0].id)).toBeUndefined()
    expect(copied).toEqual(['  exact\nvalue '])
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

    const reopened = createVaultBackend(storage, vaultCrypto(), clock)
    await reopened.unlock('pw-123456')
    expect(reopened.view().lenses).toEqual([])
    expect(reopened.view().bin.map((l) => l.name)).toEqual(['Only'])
  })

  it('saves an empty bin after deleting or restoring its last entry', async () => {
    const { storage, backend } = await freshVault()
    const a = await backend.createLens('A')
    const b = await backend.createLens('B')
    await backend.forgetLens(a)
    await backend.deleteLensForever(a)
    expect(storage.getItem(STORAGE_KEYS.bin)).toBe('[]')

    await backend.forgetLens(b)
    await backend.restoreLens(b)
    expect(storage.getItem(STORAGE_KEYS.bin)).toBe('[]')
    expect(storedList(storage, STORAGE_KEYS.lenses).map((l) => l.name)).toEqual(['B'])
  })

  it('saves an empty bin when the 7-day purge empties it', async () => {
    const { storage, backend } = await freshVault()
    await backend.createLens('Keep')
    const old = await backend.createLens('Old')
    await backend.forgetLens(old)
    const bin = storedList(storage, STORAGE_KEYS.bin)
    bin[0].deletedAt = new Date(NOW.getTime() - 8 * 24 * 3600 * 1000).toISOString()
    storage.setItem(STORAGE_KEYS.bin, JSON.stringify(bin))

    const reopened = createVaultBackend(storage, vaultCrypto(), clock)
    await reopened.unlock('pw-123456')
    expect(storage.getItem(STORAGE_KEYS.bin)).toBe('[]')
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

    const reopened = createVaultBackend(storage, vaultCrypto(), clock)
    await reopened.unlock('pw-123456')
    expect(reopened.view().bin.map((l) => l.name)).toEqual(['Recent'])
    expect(storedList(storage, STORAGE_KEYS.bin).map((l) => l.name)).toEqual(['Recent'])
  })
})

describe('lock (S1)', () => {
  it('zeroes every key it held', async () => {
    const seen: Uint8Array[] = []
    const watching = {
      ...fakeCrypto,
      encryptLensMasterKey: async (lensKey: Uint8Array, appKey: Uint8Array) => {
        seen.push(lensKey, appKey)
        return fakeCrypto.encryptLensMasterKey(lensKey, appKey)
      },
    }
    const backend = createVaultBackend(new MemoryStorage(), vaultCrypto(watching), clock)
    await backend.create('pw-123456')
    await backend.createLens('A')
    await backend.createLens('B')
    expect(seen.every((key) => key.some((byte) => byte !== 0))).toBe(true)

    await backend.lock()
    expect(seen.length).toBe(4)
    expect(seen.every((key) => key.every((byte) => byte === 0))).toBe(true)
    expect(backend.view()).toEqual({ lenses: [], bin: [], unreadable: 0 })
  })

  it('refuses every change and reveal after Lock, leaving storage untouched', async () => {
    const { storage, backend } = await freshVault()
    const a = await backend.createLens('A')
    const b = await backend.createLens('B')
    await backend.addItem(a, { label: 'L', type: 'password', value: 'v' })
    const itemId = backend.view().lenses.find((l) => l.id === a)!.items[0].id
    await backend.forgetLens(b)
    const before = new Map(storage.data)

    await backend.lock()
    await expect(backend.forgetLens(a)).rejects.toThrow(VaultLockedError)
    await expect(backend.restoreLens(b)).rejects.toThrow(VaultLockedError)
    await expect(backend.deleteLensForever(b)).rejects.toThrow(VaultLockedError)
    await expect(backend.createLens('C')).rejects.toThrow(VaultLockedError)
    await expect(backend.addItem(a, { label: 'M', type: 'note', value: 'w' })).rejects.toThrow(VaultLockedError)
    await expect(backend.deleteItem(a, itemId)).rejects.toThrow(VaultLockedError)
    await expect(backend.revealItem(a, itemId)).rejects.toThrow(VaultLockedError)
    await expect(backend.copyItem(a, itemId)).rejects.toThrow(VaultLockedError)
    expect(storage.data).toEqual(before)

    expect(await backend.unlock('pw-123456')).toEqual({ ok: true })
    expect(await backend.revealItem(a, itemId)).toBe('v')
  })

  it('does not write a change that was waiting on crypto when Lock happened', async () => {
    let release!: () => void
    const gate = new Promise<void>((resolve) => (release = resolve))
    const slow = {
      ...fakeCrypto,
      encrypt: async (plaintext: string, key: Uint8Array) => {
        await gate
        return fakeCrypto.encrypt(plaintext, key)
      },
    }
    const storage = new MemoryStorage()
    const backend = createVaultBackend(storage, vaultCrypto(slow), clock)
    await backend.create('pw-123456')
    const a = await backend.createLens('A')
    const before = new Map(storage.data)

    const pending = backend.addItem(a, { label: 'L', type: 'password', value: 'v' })
    await Promise.resolve()
    await backend.lock()
    release()

    await expect(pending).rejects.toThrow()
    expect(storage.data).toEqual(before)
  })
})

describe('failed writes (B5)', () => {
  it('reject with VaultWriteError and change nothing in memory or storage', async () => {
    const { storage, backend } = await freshVault()
    const lensId = await backend.createLens('A')
    const view = backend.view()
    const before = new Map(storage.data)
    storage.failWrites = true

    await expect(backend.addItem(lensId, { label: 'L', type: 'password', value: 'v' })).rejects.toThrow(VaultWriteError)
    await expect(backend.createLens('B')).rejects.toThrow(VaultWriteError)
    await expect(backend.forgetLens(lensId)).rejects.toThrow(VaultWriteError)
    expect(backend.view()).toEqual(view)
    expect(storage.data).toEqual(before)

    storage.failWrites = false
    await backend.addItem(lensId, { label: 'L', type: 'password', value: 'v' })
    expect(backend.view().lenses[0].itemCount).toBe(1)
  })

  it('save a Lens moving between lists in one write, so it is never missing from both', async () => {
    const { storage, backend } = await freshVault()
    const a = await backend.createLens('A')
    await backend.createLens('B')

    storage.writes = []
    await backend.forgetLens(a)
    await backend.restoreLens(a)
    expect(storage.writes).toEqual([
      [STORAGE_KEYS.lenses, STORAGE_KEYS.bin],
      [STORAGE_KEYS.lenses, STORAGE_KEYS.bin],
    ])
  })

  it('leave both lists as they were when a write touching both fails', async () => {
    const { storage, backend } = await freshVault()
    const a = await backend.createLens('A')
    const before = new Map(storage.data)
    storage.failKeys.add(STORAGE_KEYS.lenses)

    await expect(backend.forgetLens(a)).rejects.toThrow(VaultWriteError)
    expect(storage.data).toEqual(before)
    expect(backend.view().lenses.map((l) => l.id)).toEqual([a])
  })

  it('keep a change that was still being saved when Lock happened hidden', async () => {
    const { storage, backend } = await freshVault()
    const a = await backend.createLens('A')
    let release!: () => void
    storage.gate = new Promise<void>((resolve) => (release = resolve))

    const pending = backend.forgetLens(a)
    await Promise.resolve()
    await backend.lock()
    release()
    await pending

    // Saved (it was asked for before Lock), but nothing reappears while locked.
    expect(storedList(storage, STORAGE_KEYS.bin).map((l) => l.id)).toEqual([a])
    expect(backend.view()).toEqual({ lenses: [], bin: [], unreadable: 0 })
  })
})

describe('data that cannot be read', () => {
  it('keeps a Lens whose key cannot be unwrapped, byte for byte, through other changes', async () => {
    const { storage, backend } = await freshVault()
    await backend.createLens('Good')
    const broken: PersistedLens = {
      id: 'broken', name: 'Broken', createdAt: '2026-01-01T00:00:00.000Z', itemCount: 1,
      encryptedMasterKey: fakeCrypto.fakeLensKeyBlob(new Uint8Array(32).fill(9), new Uint8Array(32).fill(8)),
      items: [{ id: 'i', label: 'x', type: 'password', encryptedValue: 'opaque' }],
    }
    storage.setItem(STORAGE_KEYS.lenses, JSON.stringify([...storedList(storage, STORAGE_KEYS.lenses), broken]))

    const reopened = createVaultBackend(storage, vaultCrypto(), clock)
    await reopened.unlock('pw-123456')
    expect(reopened.view().unreadable).toBe(1)
    expect(reopened.view().lenses.map((l) => l.name)).toEqual(['Good'])

    await reopened.createLens('New')
    await reopened.forgetLens(reopened.view().lenses.find((l) => l.name === 'Good')!.id)
    expect(storedList(storage, STORAGE_KEYS.lenses).find((l) => l.id === 'broken')).toEqual(broken)
  })

  for (const [what, value] of [['invalid JSON', '{oops'], ['not a list', '{"id":"x"}']]) {
    it(`refuses to open a vault whose Lens list is ${what}, and writes nothing`, async () => {
      const { storage } = await freshVault()
      storage.setItem(STORAGE_KEYS.bin, value)
      const before = new Map(storage.data)
      storage.writes = []

      const reopened = createVaultBackend(storage, vaultCrypto(), clock)
      expect(await reopened.unlock('pw-123456')).toEqual({ ok: false, reason: 'unreadable-data' })
      expect(reopened.status()).toBe('locked')
      expect(storage.writes).toEqual([])
      expect(storage.data).toEqual(before)
    })
  }
})

describe('vault data without its key (B4)', () => {
  const orphanLens = JSON.stringify([{ id: 'o', name: 'Orphan', createdAt: '', itemCount: 0, encryptedMasterKey: 'x', items: [] }])

  it('reports orphaned data: Lenses without a key, or a key without its salt', () => {
    expect(createVaultBackend(new MemoryStorage({ [STORAGE_KEYS.lenses]: orphanLens }), vaultCrypto(), clock).status()).toBe('orphaned')
    expect(createVaultBackend(new MemoryStorage({ [STORAGE_KEYS.bin]: '{broken' }), vaultCrypto(), clock).status()).toBe('orphaned')
    expect(createVaultBackend(new MemoryStorage({ [STORAGE_KEYS.masterKey]: 'k' }), vaultCrypto(), clock).status()).toBe('orphaned')
    expect(createVaultBackend(new MemoryStorage({ [STORAGE_KEYS.lenses]: '[]', [STORAGE_KEYS.bin]: '[]' }), vaultCrypto(), clock).status()).toBe('empty')
  })

  it('refuses to create a vault over existing data', async () => {
    const storage = new MemoryStorage({ [STORAGE_KEYS.lenses]: orphanLens })
    const backend = createVaultBackend(storage, vaultCrypto(), clock)
    await expect(backend.create('pw-123456')).rejects.toThrow('Vault data already exists')
    expect(storage.getItem(STORAGE_KEYS.masterKey)).toBeNull()

    const { storage: full } = await freshVault()
    await expect(createVaultBackend(full, vaultCrypto(), clock).create('other')).rejects.toThrow()
  })

  it('sets data aside by copying every value before removing the originals', async () => {
    const storage = new MemoryStorage({ [STORAGE_KEYS.lenses]: orphanLens, [STORAGE_KEYS.hasPin]: 'true', [STORAGE_KEYS.masterKey]: 'k' })
    const backend = createVaultBackend(storage, vaultCrypto(), clock)
    const prefix = await backend.setAside()

    expect(prefix).toBe(`still-set-aside-${NOW.toISOString()}-`)
    expect(Object.fromEntries(storage.data)).toEqual({
      [prefix + STORAGE_KEYS.lenses]: orphanLens,
      [prefix + STORAGE_KEYS.hasPin]: 'true',
      [prefix + STORAGE_KEYS.masterKey]: 'k',
    })
    expect(backend.status()).toBe('empty')
    await backend.create('pw-123456')
    expect(backend.status()).toBe('unlocked')
  })

  it('removes nothing if copying fails', async () => {
    const storage = new MemoryStorage({ [STORAGE_KEYS.lenses]: orphanLens })
    storage.failWrites = true
    const backend = createVaultBackend(storage, vaultCrypto(), clock)
    await expect(backend.setAside()).rejects.toThrow()
    expect(storage.getItem(STORAGE_KEYS.lenses)).toBe(orphanLens)
  })
})

describe('golden fixtures with the real crypto', () => {
  it('classifies a wrong password as wrong-password with the real libsodium', async () => {
    const vault = JSON.parse(readFileSync(new URL('../../../fixtures/vault-v1-real/vault.json', import.meta.url), 'utf8'))
    const backend = createVaultBackend(new MemoryStorage(vault), vaultCrypto(realCrypto), clock)
    expect(await backend.unlock('throwaway-vault-20')).toEqual({ ok: false, reason: 'wrong-password' })
  })

  for (const fixture of ['vault-v1', 'vault-v1-real', 'vault-v1-rust']) {
    it(`opens ${fixture} and reveals every secret exactly`, async () => {
      const read = (name: string) =>
        JSON.parse(readFileSync(new URL(`../../../fixtures/${fixture}/${name}`, import.meta.url), 'utf8'))
      const vault = read('vault.json')
      const expected = read('expected.json')
      const storage = new MemoryStorage(vault)
      // A fixed clock inside the recycle window, so the bin entry isn't purged.
      const backend = createVaultBackend(storage, vaultCrypto(realCrypto), () => new Date('2026-09-28T00:00:00.000Z'))

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
