import { afterEach, describe, expect, it, vi } from 'vitest'

const invoke = vi.fn()
vi.mock('@tauri-apps/api/core', () => ({ invoke: (...args: unknown[]) => invoke(...args) }))

import { VaultFileError, vaultFile } from './vaultFile'

afterEach(() => invoke.mockReset())

describe('the vault file commands', () => {
  it('loads values, or reports why there are none', async () => {
    invoke.mockResolvedValueOnce({ status: 'values', values: { a: '1' } }).mockResolvedValueOnce({ status: 'already-open', values: null })
    expect(await vaultFile.load()).toEqual({ status: 'values', values: { a: '1' } })
    expect(await vaultFile.load()).toEqual({ status: 'already-open' })
    expect(invoke).toHaveBeenCalledWith('storage_load', undefined)
  })

  it('sends imports with the arguments Rust expects', async () => {
    invoke.mockResolvedValue(null)
    await vaultFile.importLegacy({ a: '1' })
    expect(invoke.mock.calls).toEqual([['storage_import_legacy', { values: { a: '1' } }]])
  })

  it('turns a Rust error code into a VaultFileError', async () => {
    invoke.mockRejectedValue('unreadable-data')
    await expect(vaultFile.importLegacy({})).rejects.toEqual(new VaultFileError('unreadable-data'))
  })
})
