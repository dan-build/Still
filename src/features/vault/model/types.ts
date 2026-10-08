// The vault as the page sees it: ids and metadata, never a key or an
// encrypted value. Rust keeps the stored vault (crates/still-core/src/vault)
// and sends this view after every command.

export type ItemType = 'password' | 'key' | 'note'

/** Archived Lenses are deleted for good this many days after they were forgotten. */
export const RECYCLE_DAYS = 7

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
  /** Set only for Lenses in the Archive. */
  deletedAt?: string
}

export interface VaultView {
  lenses: LensView[]
  bin: LensView[]
  /** Lenses whose key could not be unwrapped. They are kept, unchanged, but not shown. */
  unreadable: number
}

/** 'orphaned': vault data exists but the master key or salt is missing, so it can't be opened. */
export type VaultStatus = 'empty' | 'locked' | 'unlocked' | 'orphaned'

export interface VaultState {
  status: VaultStatus
  view: VaultView
}

export interface NewItem {
  label: string
  type: ItemType
  value: string
}

/** An edit to a secret. Without a value, the stored one is kept as it is. */
export interface ItemEdit {
  label: string
  type: ItemType
  value?: string
}

/**
 * wrong-password: the password didn't open the vault.
 * unreadable-data: stored vault data is damaged; nothing was opened or changed.
 * failed: something else went wrong, e.g. not enough memory for Argon2id.
 */
export type UnlockResult = { ok: true; state: VaultState } | { ok: false; reason: 'wrong-password' | 'unreadable-data' | 'failed' | 'no-vault' }
