// An in-memory stand-in for the vault commands (src/platform/tauri/vaultApi.ts),
// for UI tests. It keeps values in plain text and follows the commands'
// contract: every change returns the new state, a refused change throws a
// VaultApiError and changes nothing, and nothing works while locked. The real
// rules (storage, purge, unreadable data) are Rust's, tested there against
// fixtures/vault-behaviour-v1.

import { VaultApiError, type VaultApi } from '@/platform/tauri/vaultApi'
import type { ItemType, LensView, VaultState, VaultStatus } from '@/features/vault/model/types'

export interface FakeItem {
  id: string
  label: string
  type: ItemType
  value: string
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
  lenses: FakeLens[] = []
  bin: FakeLens[] = []
  unlocked = false
  /** Every change is refused, as when the disk refuses the write. */
  failChanges = false
  /** The command of every call, in order. */
  calls: string[] = []
  /** What copyItem put on the clipboard. */
  clipboard: string[] = []
  /** The prefixes set-aside used. */
  setAsides: string[] = []
  private ids = 0

  constructor(seed: { password?: string; lenses?: FakeLens[]; bin?: FakeLens[] } = {}) {
    this.password = seed.password ?? null
    this.lenses = seed.lenses ?? []
    this.bin = seed.bin ?? []
  }

  private status(): VaultStatus {
    if (this.unlocked) return 'unlocked'
    if (this.password !== null) return 'locked'
    return this.orphaned ? 'orphaned' : 'empty'
  }

  private now(): VaultState {
    const view = (lens: FakeLens): LensView => ({
      id: lens.id,
      name: lens.name,
      createdAt: lens.createdAt,
      itemCount: lens.items.length,
      items: lens.items.map(({ id, label, type }) => ({ id, label, type })),
      ...(lens.deletedAt ? { deletedAt: lens.deletedAt } : {}),
    })
    if (!this.unlocked) return { status: this.status(), view: { lenses: [], bin: [], unreadable: 0 } }
    const readable = (lens: FakeLens) => !lens.unreadable
    return {
      status: 'unlocked',
      view: {
        lenses: this.lenses.filter(readable).map(view),
        bin: this.bin.filter(readable).map(view),
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

  private item(lensId: string, itemId: string): FakeItem {
    const lens = [...this.lenses, ...this.bin].find((l) => l.id === lensId && !l.unreadable)
    const item = lens?.items.find((i) => i.id === itemId)
    if (!item) throw new VaultApiError('unknown-item')
    return item
  }

  private newId() {
    return `new-${++this.ids}`
  }

  async state() {
    this.calls.push('state')
    return this.now()
  }

  async create(password: string) {
    this.calls.push('create')
    if (this.password !== null || this.orphaned) throw new VaultApiError('vault-exists')
    this.password = password
    this.unlocked = true
    return this.now()
  }

  async unlock(password: string) {
    this.calls.push('unlock')
    if (this.password === null) return { ok: false, reason: 'no-vault' } as const
    if (this.unreadableData) return { ok: false, reason: 'unreadable-data' } as const
    if (password !== this.password) return { ok: false, reason: 'wrong-password' } as const
    this.unlocked = true
    return { ok: true, state: this.now() } as const
  }

  async lock() {
    this.calls.push('lock')
    this.unlocked = false
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
      const lens = this.bin.find((l) => l.id === lensId)
      if (!lens) return
      const { deletedAt: _deletedAt, ...restored } = lens
      this.bin = this.bin.filter((l) => l !== lens)
      this.lenses = [restored, ...this.lenses]
    })
  }

  deleteLensForever(lensId: string) {
    return this.change('deleteLensForever', () => {
      this.bin = this.bin.filter((l) => l.id !== lensId)
    })
  }

  addItem(lensId: string, item: { label: string; type: ItemType; value: string }) {
    return this.change('addItem', () => {
      if (item.value.trim() === '') throw new VaultApiError('empty-value')
      this.lens(lensId).items.push({ id: this.newId(), ...item })
    })
  }

  updateItem(lensId: string, itemId: string, edit: { label: string; type: ItemType; value?: string }) {
    return this.change('updateItem', () => {
      this.lens(lensId)
      const item = this.item(lensId, itemId)
      if (edit.label.trim() === '') throw new VaultApiError('empty-label')
      Object.assign(item, { label: edit.label.trim(), type: edit.type }, edit.value === undefined ? {} : { value: edit.value })
    })
  }

  deleteItem(lensId: string, itemId: string) {
    return this.change('deleteItem', () => {
      const lens = this.lens(lensId)
      lens.items = lens.items.filter((i) => i.id !== itemId)
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
}
