// An in-memory stand-in for the vault commands (src/platform/tauri/vaultApi.ts),
// for UI tests. It keeps values in plain text and follows the commands'
// contract: every change returns the new state, a refused change throws a
// VaultApiError and changes nothing, and nothing works while locked. The real
// rules (storage, purge, unreadable data) are Rust's, tested there against
// fixtures/vault-behaviour-v1.

import { VaultApiError, type VaultApi } from '@/platform/tauri/vaultApi'
import {
  RECYCLE_DAYS,
  URL_MAX,
  USERNAME_MAX,
  type BackupSummary,
  type GeneratorOptions,
  type ItemType,
  type KeptCopy,
  type LensView,
  type VaultState,
  type VaultStatus,
} from '@/features/vault/model/types'

const DAY_MS = 24 * 60 * 60 * 1000

export interface FakeItem {
  id: string
  label: string
  type: ItemType
  value: string
  username?: string
  url?: string
}

/** As in Rust: trimmed, only on passwords, blank means none; too long is refused. */
function details(type: ItemType, given: { username?: string; url?: string }): { username?: string; url?: string } {
  const out: { username?: string; url?: string } = {}
  for (const [key, max, code] of [
    ['username', USERNAME_MAX, 'username-too-long'],
    ['url', URL_MAX, 'url-too-long'],
  ] as const) {
    const text = given[key]?.trim()
    if (!text || type !== 'password') continue
    if (text.length > max) throw new VaultApiError(code)
    out[key] = text
  }
  return out
}

export interface FakeLens {
  id: string
  name: string
  createdAt: string
  items: FakeItem[]
  deletedAt?: string
  /** Its key doesn't open: kept, counted, never shown. */
  unreadable?: boolean
}

/** A Lens with one secret, `<name> secret`, whose value is `value-of-<id>`. */
export function fakeLens(id: string, name: string, extra: Partial<FakeLens> = {}): FakeLens {
  return {
    id,
    name,
    createdAt: '2026-01-01T00:00:00.000Z',
    items: [{ id: `${id}-item`, label: `${name} secret`, type: 'password', value: `value-of-${id}` }],
    ...extra,
  }
}

export class FakeVault implements VaultApi {
  /** The master password; null when no vault is stored. */
  password: string | null = null
  /** Vault data without its key: create refuses and the recovery screen shows. */
  orphaned = false
  /** Unlock reports damaged vault data. */
  unreadableData = false
  /** With unreadableData: Rust found a kept copy to put back. */
  canRestore = false
  /** What a password change reports as still opening with the old password. */
  olderCopies: string[] = []
  /** The settings of each password change, in order. */
  strengths: ('standard' | 'stronger')[] = []
  /** Refuse a password change as an old-format vault (needs-upgrade). */
  oldFormat = false
  /** What the save dialog returns: a file name, or null for Cancel. */
  backupSavedAs: string | null = 'Still backup 2026-11-08.json'
  /** The backup the open dialog picks (null for Cancel), with its password and contents. */
  backupChosen: { name: string; modifiedAt: number; password: string; summary: BackupSummary; lenses: FakeLens[] } | 'not-a-vault' | null = null
  private backupChecked = false
  /** Copies Still kept next to the vault. */
  kept: KeptCopy[] = []
  lenses: FakeLens[] = []
  bin: FakeLens[] = []
  unlocked = false
  /** Every change is refused, as when the disk refuses the write. */
  failChanges = false
  /** A Lock lands while create runs: the vault is saved but stays locked. */
  lockDuringCreate = false
  /** state() fails, as when the command can't be reached. */
  failState = false
  /** What the next successful unlock tells the user (the conversion to v2). */
  unlockNotice: 'upgraded' | 'upgrade-failed' | undefined
  /** Another vault file was put in place since start-up: unlock refuses with file-replaced. */
  replacedFile = false
  /** The status while locked is 'unreadable' (the vault file became unreadable). */
  unreadableFile = false
  /** The command of every call, in order. */
  calls: string[] = []
  /** What copyItem put on the clipboard. */
  clipboard: string[] = []
  /** The prefixes set-aside used. */
  setAsides: string[] = []
  /** The options of every password generated, in order. */
  generated: GeneratorOptions[] = []
  private ids = 0

  constructor(seed: { password?: string; lenses?: FakeLens[]; bin?: FakeLens[] } = {}) {
    this.password = seed.password ?? null
    this.lenses = seed.lenses ?? []
    this.bin = seed.bin ?? []
  }

  private status(): VaultStatus {
    if (this.unlocked) return 'unlocked'
    if (this.unreadableFile) return 'unreadable'
    if (this.password !== null) return 'locked'
    return this.orphaned ? 'orphaned' : 'empty'
  }

  private now(): VaultState {
    const view = (lens: FakeLens): LensView => ({
      id: lens.id,
      name: lens.name,
      createdAt: lens.createdAt,
      itemCount: lens.items.length,
      items: lens.items.map(({ id, label, type, username, url }) => ({
        id,
        label,
        type,
        ...(username === undefined ? {} : { username }),
        ...(url === undefined ? {} : { url }),
      })),
      ...(lens.deletedAt ? { deletedAt: lens.deletedAt } : {}),
    })
    // As in Rust, Archive entries say when the purge deletes them.
    const binView = (lens: FakeLens): LensView => {
      const deleted = lens.deletedAt ? Date.parse(lens.deletedAt) : NaN
      const purgeAt = Number.isNaN(deleted) ? null : new Date(deleted + RECYCLE_DAYS * DAY_MS).toISOString()
      return { ...view(lens), purgeAt }
    }
    if (!this.unlocked) return { status: this.status(), view: { lenses: [], bin: [], unreadable: 0 } }
    const readable = (lens: FakeLens) => !lens.unreadable
    return {
      status: 'unlocked',
      view: {
        lenses: this.lenses.filter(readable).map(view),
        bin: this.bin.filter(readable).map(binView),
        unreadable: [...this.lenses, ...this.bin].filter((lens) => !readable(lens)).length,
      },
    }
  }

  /** Runs a change: refused while locked or failing, otherwise applied in full. */
  private async change(command: string, apply: () => void): Promise<VaultState> {
    this.calls.push(command)
    if (!this.unlocked) throw new VaultApiError('locked')
    if (this.failChanges) throw new VaultApiError('write-failed')
    apply()
    return this.now()
  }

  private lens(lensId: string): FakeLens {
    const lens = this.lenses.find((l) => l.id === lensId && !l.unreadable)
    if (!lens) throw new VaultApiError('unknown-lens')
    return lens
  }

  /** As in Rust: a change to a Lens whose key never opened is refused, as if it didn't exist. */
  private refuseHidden(lensId: string) {
    if ([...this.lenses, ...this.bin].some((l) => l.id === lensId && l.unreadable)) throw new VaultApiError('unknown-lens')
  }

  private item(lensId: string, itemId: string): FakeItem {
    const lens = [...this.lenses, ...this.bin].find((l) => l.id === lensId)
    const item = lens?.items.find((i) => i.id === itemId)
    if (!item) throw new VaultApiError('unknown-item')
    // As in Rust: the secret is found, but its Lens's key never opened.
    if (lens?.unreadable) throw new VaultApiError('crypto-unknown-lens')
    return item
  }

  private newId() {
    return `new-${++this.ids}`
  }

  async state() {
    this.calls.push('state')
    if (this.failState) throw new VaultApiError('failed')
    return this.now()
  }

  async create(password: string) {
    this.calls.push('create')
    if (this.password !== null || this.orphaned) throw new VaultApiError('vault-exists')
    this.password = password
    this.unlocked = !this.lockDuringCreate
    return this.now()
  }

  async unlock(password: string) {
    this.calls.push('unlock')
    if (this.password === null) return { ok: false, reason: 'no-vault' } as const
    if (this.replacedFile) return { ok: false, reason: 'file-replaced' } as const
    if (this.unreadableData) return { ok: false, reason: 'unreadable-data', ...(this.canRestore ? { canRestore: true } : {}) } as const
    if (password !== this.password) return { ok: false, reason: 'wrong-password' } as const
    this.unlocked = true
    const notice = this.unlockNotice
    this.unlockNotice = undefined
    const kept = notice === 'upgraded' ? { kept: 'vault-v1-2.json' } : {}
    return { ok: true, state: this.now(), ...(notice ? { notice } : {}), ...kept } as const
  }

  async lock() {
    this.calls.push('lock')
    this.unlocked = false
    this.deleted = null
  }

  async setAside() {
    this.calls.push('setAside')
    const prefix = `still-set-aside-${this.setAsides.length + 1}-`
    this.setAsides.push(prefix)
    this.orphaned = false
    this.password = null
    this.lenses = []
    this.bin = []
    return prefix
  }

  async changePassword(current: string, next: string, stronger: boolean) {
    this.calls.push('changePassword')
    if (!this.unlocked) throw new VaultApiError('locked')
    // As in Rust: the new password's rules first, then the vault's.
    if (next.trim() === '') throw new VaultApiError('password-blank')
    if (next.length < 8) throw new VaultApiError('password-too-short')
    if (this.oldFormat) throw new VaultApiError('needs-upgrade')
    if (current !== this.password) throw new VaultApiError('crypto-wrong-password')
    if (this.failChanges) throw new VaultApiError('write-failed')
    this.password = next
    this.strengths.push(stronger ? 'stronger' : 'standard')
    return { state: this.now(), olderCopies: this.olderCopies }
  }

  async backupSave() {
    this.calls.push('backupSave')
    if (!this.unlocked) throw new VaultApiError('locked')
    if (this.oldFormat) throw new VaultApiError('needs-upgrade')
    if (this.failChanges) throw new VaultApiError('write-failed')
    return { saved: this.backupSavedAs }
  }

  async restoreChoose() {
    this.calls.push('restoreChoose')
    if (!this.unlocked && this.status() === 'locked') throw new VaultApiError('unlock-first')
    this.backupChecked = false
    const chosen = this.backupChosen
    if (chosen === null) return { name: null }
    if (chosen === 'not-a-vault') throw new VaultApiError('not-a-vault')
    return { name: chosen.name, modifiedAt: chosen.modifiedAt }
  }

  async restoreCheck(password: string) {
    this.calls.push('restoreCheck')
    const chosen = this.backupChosen
    if (!chosen || chosen === 'not-a-vault') throw new VaultApiError('nothing-chosen')
    if (password !== chosen.password) throw new VaultApiError('wrong-password')
    this.backupChecked = true
    return chosen.summary
  }

  async restoreConfirm() {
    this.calls.push('restoreConfirm')
    const chosen = this.backupChosen
    if (!chosen || chosen === 'not-a-vault' || !this.backupChecked) throw new VaultApiError('not-checked')
    if (this.failChanges) throw new VaultApiError('write-failed')
    const kept = this.password !== null ? 'vault-before-restore.json' : null
    // As in Rust: the backup becomes the vault, and the vault locks.
    this.password = chosen.password
    this.lenses = chosen.lenses
    this.bin = []
    this.unreadableFile = false
    this.orphaned = false
    this.unlocked = false
    this.backupChecked = false
    return { kept }
  }

  async keptList() {
    this.calls.push('keptList')
    if (!this.unlocked) throw new VaultApiError('locked')
    return this.kept
  }

  async keptTrash(name: string) {
    this.calls.push('keptTrash')
    if (!this.unlocked) throw new VaultApiError('locked')
    if (!this.kept.some((k) => k.name === name)) throw new VaultApiError('trash-failed')
    this.kept = this.kept.filter((k) => k.name !== name)
    return this.kept
  }

  async createLens(name: string) {
    const id = this.newId()
    const state = await this.change('createLens', () => {
      this.lenses = [{ id, name: name.trim(), createdAt: new Date().toISOString(), items: [] }, ...this.lenses]
    })
    return { id, state }
  }

  renameLens(lensId: string, name: string) {
    return this.change('renameLens', () => {
      if (name.trim() === '') throw new VaultApiError('empty-name')
      this.lens(lensId).name = name.trim()
    })
  }

  forgetLens(lensId: string) {
    return this.change('forgetLens', () => {
      const lens = this.lens(lensId)
      this.lenses = this.lenses.filter((l) => l !== lens)
      this.bin = [{ ...lens, deletedAt: new Date().toISOString() }, ...this.bin]
    })
  }

  restoreLens(lensId: string) {
    return this.change('restoreLens', () => {
      this.refuseHidden(lensId)
      const lens = this.bin.find((l) => l.id === lensId)
      if (!lens) return
      const { deletedAt: _deletedAt, ...restored } = lens
      this.bin = this.bin.filter((l) => l !== lens)
      this.lenses = [restored, ...this.lenses]
    })
  }

  deleteLensForever(lensId: string) {
    return this.change('deleteLensForever', () => {
      this.refuseHidden(lensId)
      this.bin = this.bin.filter((l) => l.id !== lensId)
    })
  }

  addItem(lensId: string, item: { label: string; type: ItemType; value: string; username?: string; url?: string }) {
    return this.change('addItem', () => {
      if (item.value.trim() === '') throw new VaultApiError('empty-value')
      const fields = details(item.type, item)
      this.lens(lensId).items.push({ id: this.newId(), label: item.label, type: item.type, value: item.value, ...fields })
    })
  }

  updateItem(
    lensId: string,
    itemId: string,
    edit: { label: string; type: ItemType; value?: string; username?: string; url?: string },
  ) {
    return this.change('updateItem', () => {
      this.lens(lensId)
      const item = this.item(lensId, itemId)
      if (edit.label.trim() === '') throw new VaultApiError('empty-label')
      const fields = details(edit.type, edit)
      delete item.username
      delete item.url
      Object.assign(item, { label: edit.label.trim(), type: edit.type }, edit.value === undefined ? {} : { value: edit.value }, fields)
    })
  }

  /** As in Rust: the secret deleted last, until it's put back, replaced or the vault locks. */
  private deleted: { lensId: string; item: FakeItem; index: number } | null = null

  deleteItem(lensId: string, itemId: string) {
    return this.change('deleteItem', () => {
      const lens = this.lens(lensId)
      const index = lens.items.findIndex((i) => i.id === itemId)
      if (index >= 0) this.deleted = { lensId, item: lens.items[index], index }
      lens.items = lens.items.filter((i) => i.id !== itemId)
    })
  }

  restoreItem(lensId: string, itemId: string) {
    return this.change('restoreItem', () => {
      const deleted = this.deleted
      if (!deleted || deleted.lensId !== lensId || deleted.item.id !== itemId) throw new VaultApiError('unknown-item')
      const lens = this.lens(lensId)
      lens.items.splice(Math.min(deleted.index, lens.items.length), 0, deleted.item)
      this.deleted = null
    })
  }

  async revealItem(lensId: string, itemId: string) {
    this.calls.push('revealItem')
    if (!this.unlocked) throw new VaultApiError('locked')
    return this.item(lensId, itemId).value
  }

  async copyItem(lensId: string, itemId: string) {
    this.calls.push('copyItem')
    if (!this.unlocked) throw new VaultApiError('locked')
    this.clipboard.push(this.item(lensId, itemId).value)
  }

  async copyItemField(lensId: string, itemId: string, field: 'username' | 'url') {
    this.calls.push('copyItemField')
    if (!this.unlocked) throw new VaultApiError('locked')
    const text = this.item(lensId, itemId)[field]
    if (text === undefined) throw new VaultApiError('unknown-item')
    this.clipboard.push(text)
  }

  /** Not random: `word-word-…` with a count; 12 bits a word. */
  async suggestPassphrase(words: number) {
    this.calls.push('suggestPassphrase')
    if (words < 4 || words > 8) throw new VaultApiError('bad-word-count')
    this.suggested += 1
    return { value: Array.from({ length: words }, (_, i) => `word${this.suggested}${i}`).join('-'), bits: words * 12 }
  }
  suggested = 0

  /** Not zxcvbn: by length alone, with a warning for "password". */
  async ratePassword(password: string) {
    this.calls.push('ratePassword')
    const score = Math.min(4, Math.floor(password.length / 6))
    return password === 'password'
      ? { score: 0, warning: 'This is a commonly used password.', suggestions: ['Add another word or two.'] }
      : { score, warning: null, suggestions: score < 3 ? ['Add another word or two.'] : [] }
  }

  /** Not random: `generated-<n>`, padded with x to the length; 6 bits a character. */
  async generatePassword(options: GeneratorOptions) {
    this.calls.push('generatePassword')
    if (!this.unlocked) throw new VaultApiError('locked')
    if (options.length < 8 || options.length > 64) throw new VaultApiError('bad-length')
    if (!options.lower && !options.upper && !options.digits && !options.symbols) throw new VaultApiError('no-characters')
    this.generated.push(options)
    return { value: `generated-${this.generated.length}`.padEnd(options.length, 'x'), bits: options.length * 6 }
  }
}
