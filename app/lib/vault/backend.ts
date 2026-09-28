// The vault backend: the only code that touches stored vault data or keys.
// The UI sees ids and metadata; keys stay in here. Stage 3b replaces this
// localStorage + libsodium implementation with Rust commands behind the same
// interface.
//
// Every change is written to storage before it becomes visible, and changes
// run one at a time.
//
// v0.1.0 behaviour is kept on purpose until each fix lands; those spots are
// marked "v0.1.0:" with the stage 1 commit that changes them.

import type * as CryptoModule from '../crypto'
import {
  VaultDataError,
  addLens,
  deleteLensForever as deleteFromBin,
  forgetLens as moveToBin,
  parseLensList,
  purgeExpired,
  restoreLens as restoreFromBin,
  serializeLensList,
  setItems,
} from './model'
import { STORAGE_KEYS, type ItemType, type PersistedLens, type VaultLists } from './types'

export type CryptoApi = Pick<
  typeof CryptoModule,
  | 'generateMasterKey'
  | 'encryptMasterKey'
  | 'decryptMasterKey'
  | 'encryptLensMasterKey'
  | 'decryptLensMasterKey'
  | 'encrypt'
  | 'decrypt'
>

export interface KeyValueStorage {
  getItem(key: string): string | null
  setItem(key: string, value: string): void
  removeItem(key: string): void
}

/** 'orphaned': vault data exists but the master key or salt is missing, so it can't be opened. */
export type VaultStatus = 'empty' | 'locked' | 'unlocked' | 'orphaned'

export type UnlockResult = { ok: true } | { ok: false; reason: 'wrong-password' | 'unreadable-data' | 'no-vault' }

export interface ItemView {
  id: string
  label: string
  type: ItemType
}

export interface LensView {
  id: string
  name: string
  createdAt: string
  itemCount: number
  items: ItemView[]
  deletedAt?: string
}

export interface VaultView {
  lenses: LensView[]
  bin: LensView[]
  /** Lenses whose key could not be unwrapped. They are kept, unchanged, but not shown. */
  unreadable: number
}

export interface NewItem {
  label: string
  type: ItemType
  value: string
}

export interface VaultBackend {
  status(): VaultStatus
  /** Whether the vault was created with the (never implemented) PIN option. */
  hasPinFlag(): boolean
  /** Refuses (throws) while the status is 'orphaned', so existing data is never buried. */
  create(password: string, pin?: string): Promise<void>
  /**
   * Keeps a copy of every stored vault value under a new name, then clears the
   * originals, so a new vault can be created. Nothing is deleted. Returns the prefix.
   */
  setAside(): Promise<string>
  unlock(password: string): Promise<UnlockResult>
  lock(): void
  view(): VaultView
  createLens(name: string): Promise<string>
  addItem(lensId: string, item: NewItem): Promise<void>
  deleteItem(lensId: string, itemId: string): Promise<void>
  revealItem(lensId: string, itemId: string): Promise<string>
  forgetLens(lensId: string): Promise<void>
  restoreLens(lensId: string): Promise<void>
  deleteLensForever(lensId: string): Promise<void>
}

type ListName = 'lenses' | 'bin'

const toView = (lens: PersistedLens): LensView => ({
  id: lens.id,
  name: lens.name,
  createdAt: lens.createdAt,
  itemCount: lens.itemCount,
  items: lens.items.map(({ id, label, type }) => ({ id, label, type })),
  ...(lens.deletedAt ? { deletedAt: lens.deletedAt } : {}),
})

export function createLocalStorageBackend(
  storage: KeyValueStorage,
  crypto: CryptoApi,
  now: () => Date = () => new Date(),
): VaultBackend {
  let lists: VaultLists = { lenses: [], bin: [] }
  let appKey: Uint8Array | null = null
  const lensKeys = new Map<string, Uint8Array>()
  let unlocked = false
  let queue: Promise<unknown> = Promise.resolve()

  // 128 random bits. v0.1.0 used Date.now().toString(36), which repeats within
  // a millisecond and reveals the creation time; existing ids are kept as they are.
  const newId = () => Array.from(globalThis.crypto.getRandomValues(new Uint8Array(16)), (b) => b.toString(16).padStart(2, '0')).join('')

  function hasStoredVault() {
    return storage.getItem(STORAGE_KEYS.masterKey) !== null && storage.getItem(STORAGE_KEYS.salt) !== null
  }

  /** Vault data that a new vault would bury: a lone key or salt, or any Lens data. */
  function hasOrphanedData() {
    if (hasStoredVault()) return false
    if (storage.getItem(STORAGE_KEYS.masterKey) !== null || storage.getItem(STORAGE_KEYS.salt) !== null) return true
    return [STORAGE_KEYS.lenses, STORAGE_KEYS.bin].some((key) => {
      const raw = storage.getItem(key)
      return raw !== null && raw.trim() !== '[]'
    })
  }

  /** Reads both stored lists; throws VaultDataError if either is not a JSON list. */
  function readLists(): VaultLists {
    return { lenses: parseLensList(storage.getItem(STORAGE_KEYS.lenses)), bin: parseLensList(storage.getItem(STORAGE_KEYS.bin)) }
  }

  /**
   * Unwraps each Lens key. A Lens whose key can't be unwrapped stays in the
   * lists exactly as stored, so saving writes it back unchanged; it just isn't shown.
   */
  async function openLists(stored: VaultLists, key: Uint8Array) {
    const opened: VaultLists = { lenses: [], bin: [] }
    lensKeys.clear()
    for (const name of ['lenses', 'bin'] as const) {
      for (const lens of stored[name]) {
        try {
          lensKeys.set(lens.id, await crypto.decryptLensMasterKey(lens.encryptedMasterKey, key))
          opened[name].push({ ...lens, items: lens.items ?? [] })
        } catch {
          opened[name].push(lens)
        }
      }
    }
    lists = opened
    const purged = purgeExpired(lists, now())
    if (purged.bin.length !== lists.bin.length) write(purged, ['bin'])
  }

  function write(next: VaultLists, which: ListName[]) {
    for (const name of which) {
      const list = next[name]
      storage.setItem(name === 'lenses' ? STORAGE_KEYS.lenses : STORAGE_KEYS.bin, serializeLensList(list))
    }
    lists = next
  }

  /** Runs changes one at a time, in order. */
  function serial<T>(task: () => Promise<T>): Promise<T> {
    const run = queue.then(task)
    queue = run.catch(() => undefined)
    return run
  }

  function requireAppKey(): Uint8Array {
    if (!appKey) throw new Error('Vault is locked')
    return appKey
  }

  function lensKey(lensId: string): Uint8Array {
    const key = lensKeys.get(lensId)
    if (!key) throw new Error('Unknown Lens')
    return key
  }

  return {
    status() {
      if (unlocked) return 'unlocked'
      if (hasStoredVault()) return 'locked'
      return hasOrphanedData() ? 'orphaned' : 'empty'
    },

    hasPinFlag() {
      return storage.getItem(STORAGE_KEYS.hasPin) === 'true'
    },

    create(password, pin) {
      return serial(async () => {
        if (hasStoredVault() || hasOrphanedData()) throw new VaultDataError('Vault data already exists')
        const key = await crypto.generateMasterKey()
        const { encryptedMasterKey, salt } = await crypto.encryptMasterKey(key, password)
        storage.setItem(STORAGE_KEYS.masterKey, encryptedMasterKey)
        storage.setItem(STORAGE_KEYS.salt, salt)
        storage.setItem(STORAGE_KEYS.hasPin, pin ? 'true' : 'false')
        appKey = key
        unlocked = true
        lists = { lenses: [], bin: [] }
        lensKeys.clear()
      })
    },

    setAside() {
      return serial(async () => {
        const prefix = `still-set-aside-${now().toISOString()}-`
        const keys = Object.values(STORAGE_KEYS)
        const values = keys.map((key) => [key, storage.getItem(key)] as const)
        for (const [key, value] of values) if (value !== null) storage.setItem(prefix + key, value)
        for (const [key, value] of values) {
          if (value !== null && storage.getItem(prefix + key) !== value) throw new VaultDataError('Could not copy vault data')
        }
        for (const [key, value] of values) if (value !== null) storage.removeItem(key)
        return prefix
      })
    },

    unlock(password) {
      return serial(async (): Promise<UnlockResult> => {
        const blob = storage.getItem(STORAGE_KEYS.masterKey)
        const salt = storage.getItem(STORAGE_KEYS.salt)
        if (blob === null || salt === null) return { ok: false, reason: 'no-vault' }
        let key: Uint8Array
        try {
          key = await crypto.decryptMasterKey(blob, password, salt)
        } catch {
          // v0.1.0: every failure counts as a wrong password (fixed in commit 14).
          return { ok: false, reason: 'wrong-password' }
        }
        let stored: VaultLists
        try {
          stored = readLists()
        } catch (error) {
          // Saving any change would overwrite the unreadable list, so don't open.
          if (error instanceof VaultDataError) return { ok: false, reason: 'unreadable-data' }
          throw error
        }
        appKey = key
        unlocked = true
        await openLists(stored, key)
        return { ok: true }
      })
    },

    lock() {
      // v0.1.0: keys stay in memory after Lock (fixed in commit 15).
      unlocked = false
    },

    view() {
      const readable = (lens: PersistedLens) => lensKeys.has(lens.id)
      return {
        lenses: lists.lenses.filter(readable).map(toView),
        bin: lists.bin.filter(readable).map(toView),
        unreadable: [...lists.lenses, ...lists.bin].filter((lens) => !readable(lens)).length,
      }
    },

    createLens(name) {
      return serial(async () => {
        const key = await crypto.generateMasterKey()
        const lens: PersistedLens = {
          id: newId(),
          name: name.trim(),
          createdAt: now().toISOString(),
          itemCount: 0,
          encryptedMasterKey: await crypto.encryptLensMasterKey(key, requireAppKey()),
          items: [],
        }
        write(addLens(lists, lens), ['lenses'])
        lensKeys.set(lens.id, key)
        return lens.id
      })
    },

    addItem(lensId, item) {
      return serial(async () => {
        const lens = lists.lenses.find((l) => l.id === lensId)
        if (!lens) throw new Error('Unknown Lens')
        const encryptedValue = await crypto.encrypt(item.value, lensKey(lensId))
        const items = [...lens.items, { id: newId(), label: item.label, type: item.type, encryptedValue }]
        write(setItems(lists, lensId, items), ['lenses'])
      })
    },

    deleteItem(lensId, itemId) {
      return serial(async () => {
        const lens = lists.lenses.find((l) => l.id === lensId)
        if (!lens) throw new Error('Unknown Lens')
        write(setItems(lists, lensId, lens.items.filter((i) => i.id !== itemId)), ['lenses'])
      })
    },

    async revealItem(lensId, itemId) {
      const lens = [...lists.lenses, ...lists.bin].find((l) => l.id === lensId)
      const item = lens?.items.find((i) => i.id === itemId)
      if (!item) throw new Error('Unknown item')
      return crypto.decrypt(item.encryptedValue, lensKey(lensId))
    },

    forgetLens(lensId) {
      return serial(async () => write(moveToBin(lists, lensId, now()), ['lenses', 'bin']))
    },

    restoreLens(lensId) {
      return serial(async () => write(restoreFromBin(lists, lensId), ['lenses', 'bin']))
    },

    deleteLensForever(lensId) {
      return serial(async () => write(deleteFromBin(lists, lensId), ['bin']))
    },
  }
}
