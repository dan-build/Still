import { afterEach, describe, expect, it, vi } from 'vitest'

const invoke = vi.fn()
vi.mock('@tauri-apps/api/core', () => ({ invoke: (...args: unknown[]) => invoke(...args) }))

import { createTauriVaultApi, VaultApiError } from './vaultApi'
import { fakeWebStorage } from '@/test/fakeWebStorage'

const api = createTauriVaultApi()

afterEach(() => invoke.mockReset())

describe('the vault commands', () => {
  // The names must match the commands in src-tauri/src/commands.rs, and the
  // argument names their parameters, which Tauri reads in camelCase.
  it('calls each command with the arguments Rust expects', async () => {
    invoke.mockResolvedValue({ id: 'new', state: {} })
    await api.state()
    await api.create('pw')
    await api.unlock('  pw  ')
    await api.lock()
    await api.setAside()
    await api.backupSave()
    await api.restoreChoose()
    await api.restoreCheck(' backup pw ')
    await api.restoreConfirm()
    await api.keptList()
    await api.keptTrash('vault-v1.json')
    await api.changePassword('old pw', ' new pw ', true)
    await api.createLens('Work')
    await api.renameLens('a', 'Home')
    await api.forgetLens('a')
    await api.restoreLens('a')
    await api.deleteLensForever('a')
    await api.addItem('a', { label: 'L', type: 'note', value: '  v\n' })
    await api.updateItem('a', 'i', { label: 'L', type: 'key' })
    await api.updateItem('a', 'i', { label: 'L', type: 'key', value: 'w' })
    await api.deleteItem('a', 'i')
    await api.restoreItem('a', 'i')
    await api.revealItem('a', 'i')
    await api.copyItem('a', 'i')
    const options = { length: 20, lower: true, upper: true, digits: true, symbols: false, avoidLookAlikes: true }
    await api.generatePassword(options)
    expect(invoke.mock.calls).toEqual([
      ['vault_state', undefined],
      ['vault_create', { password: 'pw' }],
      ['vault_unlock', { password: '  pw  ' }],
      ['vault_lock', undefined],
      ['vault_set_aside', undefined],
      ['backup_save', undefined],
      ['restore_choose', undefined],
      ['restore_check', { password: ' backup pw ' }],
      ['restore_confirm', undefined],
      ['kept_list', undefined],
      ['kept_trash', { name: 'vault-v1.json' }],
      ['vault_change_password', { current: 'old pw', new: ' new pw ', stronger: true }],
      ['lens_create', { name: 'Work' }],
      ['lens_rename', { lensId: 'a', name: 'Home' }],
      ['lens_forget', { lensId: 'a' }],
      ['lens_restore', { lensId: 'a' }],
      ['lens_delete', { lensId: 'a' }],
      ['item_add', { lensId: 'a', label: 'L', itemType: 'note', value: '  v\n' }],
      ['item_update', { lensId: 'a', itemId: 'i', label: 'L', itemType: 'key', value: null }],
      ['item_update', { lensId: 'a', itemId: 'i', label: 'L', itemType: 'key', value: 'w' }],
      ['item_delete', { lensId: 'a', itemId: 'i' }],
      ['item_restore', { lensId: 'a', itemId: 'i' }],
      ['item_reveal', { lensId: 'a', itemId: 'i' }],
      ['item_copy', { lensId: 'a', itemId: 'i' }],
      // One argument, read by Rust's GenerateOptions (camelCase, unknown fields refused).
      ['password_generate', { options }],
    ])
  })

  it('passes results through unchanged', async () => {
    const state = { status: 'unlocked', view: { lenses: [], bin: [], unreadable: 0 } }
    invoke.mockResolvedValueOnce({ ok: true, state }).mockResolvedValueOnce({ ok: false, reason: 'wrong-password' })
    expect(await api.unlock('pw')).toEqual({ ok: true, state })
    expect(await api.unlock('pw')).toEqual({ ok: false, reason: 'wrong-password' })
  })

  it('turns a Rust error code into a VaultApiError, and anything else into failed', async () => {
    invoke.mockRejectedValueOnce('write-failed').mockRejectedValueOnce(new Error('command not allowed'))
    await expect(api.forgetLens('a')).rejects.toEqual(new VaultApiError('write-failed'))
    await expect(api.forgetLens('a')).rejects.toEqual(new VaultApiError('failed'))
  })

  it('passes an upgrade to v2 through, writing nothing to localStorage (Rust records it)', async () => {
    const legacy = fakeWebStorage()
    vi.stubGlobal('localStorage', legacy)
    try {
      const state = { status: 'unlocked', view: { lenses: [], bin: [], unreadable: 0 } }
      invoke.mockResolvedValueOnce({ ok: true, state, notice: 'upgraded', kept: 'vault-v1.json' })
      expect(await api.unlock('pw')).toEqual({ ok: true, state, notice: 'upgraded', kept: 'vault-v1.json' })
      expect(legacy.data.size).toBe(0)
    } finally {
      vi.unstubAllGlobals()
    }
  })
})

