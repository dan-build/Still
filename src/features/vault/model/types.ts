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
  /** A password's username and website, when it has them (v0.11.0). */
  username?: string
  url?: string
}

/** The longest username and website Rust keeps, in UTF-16 code units (as `.length` counts). */
export const USERNAME_MAX = 256
export const URL_MAX = 2048

export interface LensView {
  id: string
  name: string
  createdAt: string
  itemCount: number
  items: ItemView[]
  /** Set only for Lenses in the Archive. */
  deletedAt?: string
  /**
   * Set only for Lenses in the Archive: when the purge deletes it for good, or
   * null if its date can't be read, so it's kept until deleted by hand.
   */
  purgeAt?: string | null
}

export interface VaultView {
  lenses: LensView[]
  bin: LensView[]
  /** Lenses whose key could not be unwrapped. They are kept, unchanged, but not shown. */
  unreadable: number
}

/**
 * 'orphaned': vault data exists but the master key or salt is missing, so it can't be opened.
 * 'unreadable': the vault file can't be read; nothing is offered that could write over it.
 */
export type VaultStatus = 'empty' | 'locked' | 'unlocked' | 'orphaned' | 'unreadable'

export interface VaultState {
  status: VaultStatus
  view: VaultView
}

/**
 * A new secret. username and url apply to passwords only; blank or missing
 * means none.
 */
export interface NewItem {
  label: string
  type: ItemType
  value: string
  username?: string
  url?: string
}

/**
 * An edit to a secret. Without a value, the stored one is kept as it is. The
 * username and website are set as given: missing or blank removes them, so
 * an edit always sends the ones to keep.
 */
export interface ItemEdit {
  label: string
  type: ItemType
  value?: string
  username?: string
  url?: string
}

/**
 * wrong-password: the password didn't open the vault.
 * unreadable-data: stored vault data is damaged; nothing was opened or changed.
 * failed: something else went wrong, e.g. not enough memory for Argon2id.
 */
/** A copy Still kept next to the vault, such as vault-v1.json. */
export interface KeptCopy {
  name: string
  /** Last changed, in ms since 1970. */
  modifiedAt: number
  size: number
}

/** What a backup holds, shown before it replaces the vault. */
export interface BackupSummary {
  lenses: number
  secrets: number
  archived: number
}

export type UnlockResult =
  /**
   * notice: the vault was converted to format v2 ('upgraded'; `kept` names the
   * file kept from before), or converting failed and it is unchanged.
   */
  | { ok: true; state: VaultState; notice?: 'upgraded' | 'upgrade-failed'; kept?: string }
  /** canRestore: with unreadable-data, a kept copy can be put back (startup_restore_v1). */
  | { ok: false; reason: 'wrong-password' | 'unreadable-data' | 'failed' | 'no-vault' | 'file-replaced'; canRestore?: boolean }

/** What the password generator makes (Rust's password_generate). */
export interface GeneratorOptions {
  /** 8 to 64. */
  length: number
  lower: boolean
  upper: boolean
  digits: boolean
  symbols: boolean
  /** Leave out 0 O o 1 l I |, easy to misread when typed by hand. */
  avoidLookAlikes: boolean
}

export interface GeneratedPassword {
  value: string
  /** Its randomness in bits, from the options. */
  bits: number
}
