// The v1 vault as stored in localStorage. These shapes are the on-disk format:
// never rename, drop or reorder their fields without a migration plan and the
// owner's approval (see CLAUDE.md).

export type ItemType = 'password' | 'key' | 'note'

export interface PersistedItem {
  id: string
  label: string
  type: ItemType
  encryptedValue: string
}

export interface PersistedLens {
  id: string
  name: string
  createdAt: string
  itemCount: number
  /** The Lens key wrapped by the app master key (the name is historical). */
  encryptedMasterKey: string
  items: PersistedItem[]
  /** Set only for Lenses in the recycle bin. */
  deletedAt?: string
}

export const STORAGE_KEYS = {
  masterKey: 'still-encrypted-master-key',
  salt: 'still-salt',
  hasPin: 'still-has-pin',
  lenses: 'still-lenses',
  bin: 'still-recycle-bin',
} as const

/** The Lenses and recycle bin, exactly as stored. */
export interface VaultLists {
  lenses: PersistedLens[]
  bin: PersistedLens[]
}
