import { afterEach, describe, expect, it, vi } from 'vitest'

const invoke = vi.fn()
vi.mock('@tauri-apps/api/core', () => ({ invoke: (...args: unknown[]) => invoke(...args) }))

import { VaultFileError, vaultFile } from './vaultFile'

afterEach(() => invoke.mockReset())

describe('the vault file commands', () => {
  it('asks only whether there is a vault file, never for its values', async () => {
    invoke.mockResolvedValueOnce('values').mockResolvedValueOnce('already-open')
    expect(await vaultFile.load()).toEqual({ status: 'values' })
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
