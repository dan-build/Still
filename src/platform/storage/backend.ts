// The vault backend: the only code that touches stored vault data, and the
// only caller of the vault's crypto. The UI sees ids and metadata. Keys stay
// inside the VaultCrypto implementation; this file refers to them by Lens id.
//
// Every change is written to storage, in one all-or-nothing write, before it
// becomes visible, and changes run one at a time.
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

/**
 * Where the vault's values live: the vault file (via Rust) in the app. Reads
 * come from what was loaded; each write sets (a string) or removes (null)
 * several values at once, and either all of it is saved or none of it.
 */
export interface VaultStorage {
  get(key: string): string | null
  write(changes: Record<string, string | null>): Promise<void>
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
  /** Puts the item's value on the clipboard without returning it. */
  copyItem(lensId: string, itemId: string): Promise<void>
  forgetLens(lensId: string): Promise<void>
  restoreLens(lensId: string): Promise<void>
  deleteLensForever(lensId: string): Promise<void>
}

const toView = (lens: PersistedLens): LensView => ({
  id: lens.id,
  name: lens.name,
  createdAt: lens.createdAt,
  itemCount: lens.itemCount,
  items: lens.items.map(({ id, label, type }) => ({ id, label, type })),
  ...(lens.deletedAt ? { deletedAt: lens.deletedAt } : {}),
})

export function createVaultBackend(
  storage: VaultStorage,
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
    return storage.get(STORAGE_KEYS.masterKey) !== null && storage.get(STORAGE_KEYS.salt) !== null
  }

  /** Vault data that a new vault would bury: a lone key or salt, or any Lens data. */
  function hasOrphanedData() {
    if (hasStoredVault()) return false
    if (storage.get(STORAGE_KEYS.masterKey) !== null || storage.get(STORAGE_KEYS.salt) !== null) return true
    return [STORAGE_KEYS.lenses, STORAGE_KEYS.bin].some((key) => {
      const raw = storage.get(key)
      return raw !== null && raw.trim() !== '[]'
    })
  }

  /** Reads both stored lists; throws VaultDataError if either is not a JSON list. */
  function readLists(): VaultLists {
    return { lenses: parseLensList(storage.get(STORAGE_KEYS.lenses)), bin: parseLensList(storage.get(STORAGE_KEYS.bin)) }
  }

  /**
   * Takes the lists as unlocked. A Lens whose key couldn't be unwrapped stays
   * exactly as stored, so saving writes it back unchanged; it just isn't shown.
   */
  async function openLists(stored: VaultLists, opened: boolean[]) {
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
        await write(purged)
      } catch {
        // Unlocking still succeeds; the purge runs again next time.
      }
    }
  }

  /**
   * Saves the lists that differ from the current ones, in one write, then
   * makes them current. A Lens moving between lists is saved in both at once,
   * so it can't end up in neither. On failure nothing changes and a
   * VaultWriteError is thrown.
   */
  async function write(next: VaultLists) {
    // Lock can happen while a change is waiting on crypto. Its lists are then
    // empty, and writing them would wipe the vault, so refuse.
    if (!unlocked) throw new VaultLockedError()
    const changes: Record<string, string> = {}
    if (next.lenses !== lists.lenses) changes[STORAGE_KEYS.lenses] = serializeLensList(next.lenses)
    if (next.bin !== lists.bin) changes[STORAGE_KEYS.bin] = serializeLensList(next.bin)
    try {
      if (Object.keys(changes).length > 0) await storage.write(changes)
    } catch (error) {
      throw new VaultWriteError('Could not save the change', { cause: error })
    }
    // Locked while the write was on its way: it's saved, but stays hidden.
    if (unlocked) lists = next
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

  function storedItem(lensId: string, itemId: string) {
    requireUnlocked()
    const lens = [...lists.lenses, ...lists.bin].find((l) => l.id === lensId)
    const item = lens?.items.find((i) => i.id === itemId)
    if (!item) throw new Error('Unknown item')
    return item
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
        await storage.write({
          [STORAGE_KEYS.masterKey]: encryptedMasterKey,
          [STORAGE_KEYS.salt]: salt,
          // Kept for the v1 format; the PIN option never worked and has been removed.
          [STORAGE_KEYS.hasPin]: 'false',
        })
        unlocked = true
        lists = { lenses: [], bin: [] }
        readable.clear()
      })
    },

    setAside() {
      return serial(async () => {
        const prefix = `still-set-aside-${now().toISOString()}-`
        // Copies and removals go in one write: all of it happens or none of it.
        const changes: Record<string, string | null> = {}
        for (const key of Object.values(STORAGE_KEYS)) {
          const value = storage.get(key)
          if (value === null) continue
          changes[prefix + key] = value
          changes[key] = null
        }
        await storage.write(changes)
        return prefix
      })
    },

    unlock(password) {
      return serial(async (): Promise<UnlockResult> => {
        const blob = storage.get(STORAGE_KEYS.masterKey)
        const salt = storage.get(STORAGE_KEYS.salt)
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
        await openLists(stored, opened)
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
        await write(addLens(lists, lens))
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
        await write(setItems(lists, lensId, items))
      })
    },

    deleteItem(lensId, itemId) {
      return change(async () => {
        const lens = lists.lenses.find((l) => l.id === lensId)
        if (!lens) throw new Error('Unknown Lens')
        await write(setItems(lists, lensId, lens.items.filter((i) => i.id !== itemId)))
      })
    },

    async revealItem(lensId, itemId) {
      return crypto.decryptItem(lensId, storedItem(lensId, itemId).encryptedValue)
    },

    async copyItem(lensId, itemId) {
      return crypto.copyItem(lensId, storedItem(lensId, itemId).encryptedValue)
    },

    forgetLens(lensId) {
      return change(() => write(moveToBin(lists, lensId, now())))
    },

    restoreLens(lensId) {
      return change(() => write(restoreFromBin(lists, lensId)))
    },

    deleteLensForever(lensId) {
      return change(() => write(deleteFromBin(lists, lensId)))
    },
  }
}
