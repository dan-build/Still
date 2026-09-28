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

export type VaultStatus = 'empty' | 'locked' | 'unlocked'

export type UnlockResult = { ok: true } | { ok: false; reason: 'wrong-password' | 'no-vault' }

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
  create(password: string, pin?: string): Promise<void>
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

  function readList(key: string): PersistedLens[] {
    try {
      return parseLensList(storage.getItem(key))
    } catch {
      // v0.1.0: an unparseable list loads as empty (fixed in commit 8).
      return []
    }
  }

  async function openLists(key: Uint8Array) {
    const opened: VaultLists = { lenses: [], bin: [] }
    lensKeys.clear()
    for (const name of ['lenses', 'bin'] as const) {
      for (const lens of readList(name === 'lenses' ? STORAGE_KEYS.lenses : STORAGE_KEYS.bin)) {
        try {
          lensKeys.set(lens.id, await crypto.decryptLensMasterKey(lens.encryptedMasterKey, key))
          opened[name].push({ ...lens, items: lens.items ?? [] })
        } catch {
          // v0.1.0: an unreadable Lens is dropped, and erased by the next save (fixed in commit 8).
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
      // v0.1.0: an empty list is never written (fixed in commits 5-7).
      if (list.length === 0) continue
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
      return hasStoredVault() ? 'locked' : 'empty'
    },

    hasPinFlag() {
      return storage.getItem(STORAGE_KEYS.hasPin) === 'true'
    },

    create(password, pin) {
      return serial(async () => {
        const key = await crypto.generateMasterKey()
        const { encryptedMasterKey, salt } = await crypto.encryptMasterKey(key, password)
        storage.setItem(STORAGE_KEYS.masterKey, encryptedMasterKey)
        storage.setItem(STORAGE_KEYS.salt, salt)
        storage.setItem(STORAGE_KEYS.hasPin, pin ? 'true' : 'false')
        appKey = key
        unlocked = true
        // v0.1.0: Lenses left without a master key are opened with the new key,
        // fail, and are erased by the next save (fixed in commit 9).
        await openLists(key)
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
        appKey = key
        unlocked = true
        await openLists(key)
        return { ok: true }
      })
    },

    lock() {
      // v0.1.0: keys stay in memory after Lock (fixed in commit 15).
      unlocked = false
    },

    view() {
      return { lenses: lists.lenses.map(toView), bin: lists.bin.map(toView) }
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
