// The vault backend: the only code that touches stored vault data, and the
// only caller of the vault's crypto. The UI sees ids and metadata. Keys stay
// inside the VaultCrypto implementation; this file refers to them by Lens id.
//
// Every change is written to storage before it becomes visible, and changes
// run one at a time.
//
// v0.1.0 behaviour is kept on purpose until each fix lands; those spots are
// marked "v0.1.0:" with the stage 1 commit that changes them.

import { VaultCryptoError, type VaultCrypto } from '@/platform/crypto/vaultCrypto'
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
} from '@/features/vault/model/model'
import { isV1MasterKey } from '@/features/vault/model/format'
import { STORAGE_KEYS, type ItemType, type PersistedLens, type VaultLists } from '@/features/vault/model/types'

/** A change could not be saved. Nothing in memory or on screen changed. */
export class VaultWriteError extends Error {}

/** The vault is locked, so nothing can be read or changed. */
export class VaultLockedError extends Error {
  constructor() {
    super('Vault is locked')
  }
}

export interface KeyValueStorage {
  getItem(key: string): string | null
  setItem(key: string, value: string): void
  removeItem(key: string): void
}

/** 'orphaned': vault data exists but the master key or salt is missing, so it can't be opened. */
export type VaultStatus = 'empty' | 'locked' | 'unlocked' | 'orphaned'

/**
 * wrong-password: the password didn't open the vault.
 * unreadable-data: stored vault data is damaged; nothing was opened or changed.
 * failed: something else went wrong, e.g. not enough memory for Argon2id.
 */
export type UnlockResult = { ok: true } | { ok: false; reason: 'wrong-password' | 'unreadable-data' | 'failed' | 'no-vault' }

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
  /** Refuses (throws) while the status is 'orphaned', so existing data is never buried. */
  create(password: string): Promise<void>
  /**
   * Keeps a copy of every stored vault value under a new name, then clears the
   * originals, so a new vault can be created. Nothing is deleted. Returns the prefix.
   */
  setAside(): Promise<string>
  unlock(password: string): Promise<UnlockResult>
  /** Hides everything at once, then has the crypto zero its keys. */
  lock(): Promise<void>
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
  crypto: VaultCrypto,
  now: () => Date = () => new Date(),
): VaultBackend {
  let lists: VaultLists = { lenses: [], bin: [] }
  // Lens ids whose key the crypto holds. Others are kept but not shown.
  const readable = new Set<string>()
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
   * Takes the lists as unlocked. A Lens whose key couldn't be unwrapped stays
   * exactly as stored, so saving writes it back unchanged; it just isn't shown.
   */
  function openLists(stored: VaultLists, opened: boolean[]) {
    const all = [...stored.lenses, ...stored.bin]
    readable.clear()
    all.forEach((lens, i) => opened[i] && readable.add(lens.id))
    const open = (lens: PersistedLens, i: number) => (opened[i] ? { ...lens, items: lens.items ?? [] } : lens)
    lists = {
      lenses: stored.lenses.map((lens, i) => open(lens, i)),
      bin: stored.bin.map((lens, i) => open(lens, stored.lenses.length + i)),
    }
    const purged = purgeExpired(lists, now())
    if (purged.bin.length !== lists.bin.length) {
      try {
        write(purged, ['bin'])
      } catch {
        // Unlocking still succeeds; the purge runs again next time.
      }
    }
  }

  /**
   * Saves the given lists, then makes them current. Lists that gain entries are
   * written first, so a Lens moving between lists is never missing from both if
   * a write fails midway. On failure, lists already written are put back where
   * possible, nothing in memory changes, and a VaultWriteError is thrown.
   */
  function write(next: VaultLists, which: ListName[]) {
    // Lock can happen while a change is waiting on crypto. Its lists are then
    // empty, and writing them would wipe the vault, so refuse.
    if (!unlocked) throw new VaultLockedError()
    const keyOf = (name: ListName) => (name === 'lenses' ? STORAGE_KEYS.lenses : STORAGE_KEYS.bin)
    const ordered = [...which].sort((a, b) => (next[b].length - lists[b].length) - (next[a].length - lists[a].length))
    const written: [string, string | null][] = []
    try {
      for (const name of ordered) {
        const key = keyOf(name)
        const previous = storage.getItem(key)
        storage.setItem(key, serializeLensList(next[name]))
        written.push([key, previous])
      }
    } catch (error) {
      for (const [key, previous] of written.reverse()) {
        try {
          if (previous === null) storage.removeItem(key)
          else storage.setItem(key, previous)
        } catch {
          // Best effort: the gaining list was written first, so nothing is lost.
        }
      }
      throw new VaultWriteError('Could not save the change', { cause: error })
    }
    lists = next
  }

  /** Runs changes one at a time, in order. */
  function serial<T>(task: () => Promise<T>): Promise<T> {
    const run = queue.then(task)
    queue = run.catch(() => undefined)
    return run
  }

  function requireUnlocked() {
    if (!unlocked) throw new VaultLockedError()
  }

  /** Runs a change in order, but only while the vault is unlocked. */
  function change<T>(task: () => Promise<T>): Promise<T> {
    return serial(async () => {
      requireUnlocked()
      return task()
    })
  }

  return {
    status() {
      if (unlocked) return 'unlocked'
      if (hasStoredVault()) return 'locked'
      return hasOrphanedData() ? 'orphaned' : 'empty'
    },

    create(password) {
      return serial(async () => {
        if (hasStoredVault() || hasOrphanedData()) throw new VaultDataError('Vault data already exists')
        const { encryptedMasterKey, salt } = await crypto.createVault(password)
        storage.setItem(STORAGE_KEYS.masterKey, encryptedMasterKey)
        storage.setItem(STORAGE_KEYS.salt, salt)
        // Kept for the v1 format; the PIN option never worked and has been removed.
        storage.setItem(STORAGE_KEYS.hasPin, 'false')
        unlocked = true
        lists = { lenses: [], bin: [] }
        readable.clear()
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
        if (!isV1MasterKey(blob, salt)) return { ok: false, reason: 'unreadable-data' }
        let stored: VaultLists
        try {
          stored = readLists()
        } catch (error) {
          // Saving any change would overwrite the unreadable list, so don't open.
          if (error instanceof VaultDataError) return { ok: false, reason: 'unreadable-data' }
          throw error
        }
        let opened: boolean[]
        try {
          const wrapped = [...stored.lenses, ...stored.bin].map(({ id, encryptedMasterKey }) => ({ id, encryptedMasterKey }))
          opened = await crypto.unlock(blob, salt, password, wrapped)
        } catch (error) {
          const code = error instanceof VaultCryptoError ? error.code : 'failed'
          if (code === 'wrong-password') return { ok: false, reason: 'wrong-password' }
          return { ok: false, reason: code === 'corrupt' ? 'unreadable-data' : 'failed' }
        }
        unlocked = true
        openLists(stored, opened)
        return { ok: true }
      })
    },

    lock() {
      // Hide everything now, so nothing can be read or written from here on,
      // then have the crypto zero its keys.
      unlocked = false
      readable.clear()
      lists = { lenses: [], bin: [] }
      return crypto.lock()
    },

    view() {
      const isReadable = (lens: PersistedLens) => readable.has(lens.id)
      return {
        lenses: lists.lenses.filter(isReadable).map(toView),
        bin: lists.bin.filter(isReadable).map(toView),
        unreadable: [...lists.lenses, ...lists.bin].filter((lens) => !isReadable(lens)).length,
      }
    },

    createLens(name) {
      return change(async () => {
        const id = newId()
        const lens: PersistedLens = {
          id,
          name: name.trim(),
          createdAt: now().toISOString(),
          itemCount: 0,
          encryptedMasterKey: await crypto.newLensKey(id),
          items: [],
        }
        write(addLens(lists, lens), ['lenses'])
        readable.add(id)
        return id
      })
    },

    addItem(lensId, item) {
      return change(async () => {
        const lens = lists.lenses.find((l) => l.id === lensId)
        if (!lens) throw new Error('Unknown Lens')
        const encryptedValue = await crypto.encryptItem(lensId, item.value)
        const items = [...lens.items, { id: newId(), label: item.label, type: item.type, encryptedValue }]
        write(setItems(lists, lensId, items), ['lenses'])
      })
    },

    deleteItem(lensId, itemId) {
      return change(async () => {
        const lens = lists.lenses.find((l) => l.id === lensId)
        if (!lens) throw new Error('Unknown Lens')
        write(setItems(lists, lensId, lens.items.filter((i) => i.id !== itemId)), ['lenses'])
      })
    },

    async revealItem(lensId, itemId) {
      requireUnlocked()
      const lens = [...lists.lenses, ...lists.bin].find((l) => l.id === lensId)
      const item = lens?.items.find((i) => i.id === itemId)
      if (!item) throw new Error('Unknown item')
      return crypto.decryptItem(lensId, item.encryptedValue)
    },

    forgetLens(lensId) {
      return change(async () => write(moveToBin(lists, lensId, now()), ['lenses', 'bin']))
    },

    restoreLens(lensId) {
      return change(async () => write(restoreFromBin(lists, lensId), ['lenses', 'bin']))
    },

    deleteLensForever(lensId) {
      return change(async () => write(deleteFromBin(lists, lensId), ['bin']))
    },
  }
}
