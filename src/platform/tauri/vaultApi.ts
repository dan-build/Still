// The vault, kept in Rust (crates/still-core/src/vault, behind the commands in
// src-tauri/src/commands.rs). The page names Lenses and secrets by id and gets
// the vault's status and view back after every change; keys and encrypted
// values never reach it. A secret's value crosses only to be saved, or when
// the user reveals it. This is the only code that calls the vault commands.

import { invoke } from '@tauri-apps/api/core'
import type { ItemEdit, NewItem, UnlockResult, VaultState } from '@/features/vault/model/types'

/**
 * A refused command, by code: locked, vault-exists, unknown-lens,
 * unknown-item, empty-label, empty-name, empty-value, write-failed,
 * storage-failed, crypto-<code>, or failed (anything else).
 */
export class VaultApiError extends Error {
  constructor(readonly code: string) {
    super(code)
  }
}

export interface VaultApi {
  state(): Promise<VaultState>
  /** Refuses while vault data is stored, orphaned or not, so nothing is ever buried. */
  create(password: string): Promise<VaultState>
  unlock(password: string): Promise<UnlockResult>
  /** Locks at once (or once a change under way is saved), and clears a copied secret. */
  lock(): Promise<void>
  /**
   * Keeps a copy of every stored vault value under a new name, then removes
   * the originals, so a new vault can be created. Nothing is deleted.
   */
  setAside(): Promise<string>
  createLens(name: string): Promise<{ id: string; state: VaultState }>
  renameLens(lensId: string, name: string): Promise<VaultState>
  forgetLens(lensId: string): Promise<VaultState>
  restoreLens(lensId: string): Promise<VaultState>
  deleteLensForever(lensId: string): Promise<VaultState>
  addItem(lensId: string, item: NewItem): Promise<VaultState>
  /** Changes a secret in place (same id and position); without a value, the stored one stays. */
  updateItem(lensId: string, itemId: string, edit: ItemEdit): Promise<VaultState>
  deleteItem(lensId: string, itemId: string): Promise<VaultState>
  revealItem(lensId: string, itemId: string): Promise<string>
  /** Puts the value on the clipboard without returning it; Rust clears it after 30 seconds. */
  copyItem(lensId: string, itemId: string): Promise<void>
}

async function call<T>(command: string, args?: Record<string, unknown>): Promise<T> {
  try {
    return await invoke<T>(command, args)
  } catch (error) {
    // Rust rejects with a bare code; anything else (such as a refused command) is a failure.
    throw new VaultApiError(typeof error === 'string' ? error : 'failed')
  }
}

export function createTauriVaultApi(): VaultApi {
  return {
    state: () => call('vault_state'),
    create: (password) => call('vault_create', { password }),
    unlock: (password) => call('vault_unlock', { password }),
    lock: () => call('vault_lock'),
    setAside: () => call('vault_set_aside'),
    createLens: (name) => call('lens_create', { name }),
    renameLens: (lensId, name) => call('lens_rename', { lensId, name }),
    forgetLens: (lensId) => call('lens_forget', { lensId }),
    restoreLens: (lensId) => call('lens_restore', { lensId }),
    deleteLensForever: (lensId) => call('lens_delete', { lensId }),
    addItem: (lensId, { label, type, value }) => call('item_add', { lensId, label, itemType: type, value }),
    updateItem: (lensId, itemId, { label, type, value }) =>
      call('item_update', { lensId, itemId, label, itemType: type, value: value ?? null }),
    deleteItem: (lensId, itemId) => call('item_delete', { lensId, itemId }),
    revealItem: (lensId, itemId) => call('item_reveal', { lensId, itemId }),
    copyItem: (lensId, itemId) => call('item_copy', { lensId, itemId }),
  }
}
