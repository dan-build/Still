import { afterEach, describe, expect, it, vi } from 'vitest'
import { fakeWebStorage } from '@/test/fakeWebStorage'

const invoke = vi.fn()
vi.mock('@tauri-apps/api/core', () => ({ invoke: (...args: unknown[]) => invoke(...args) }))

import { CONVERTED_MARKER, MOVED_MARKER, openOldFormat, openVault, restoreKeptCopy, restoreOldCopy } from './startup'

afterEach(() => invoke.mockReset())

// The decisions themselves are Rust's, tested in src-tauri/src/startup.rs.
describe('start-up, seen from the page', () => {
  it('sends Rust the old values (not the marker or other apps\' keys) and the marker', async () => {
    invoke.mockResolvedValue({ kind: 'ready' })
    const legacy = fakeWebStorage({ 'still-salt': 's', 'still-lenses': '[]', [MOVED_MARKER]: '{"m":1}', 'unrelated-app-key': 'x' })
    expect(await openVault(legacy)).toEqual({ kind: 'ready' })
    expect(invoke).toHaveBeenCalledWith('startup_open', { legacy: { 'still-salt': 's', 'still-lenses': '[]' }, marker: '{"m":1}', converted: null })

    await restoreOldCopy(legacy)
    expect(invoke).toHaveBeenLastCalledWith('startup_use_old_copy', { legacy: { 'still-salt': 's', 'still-lenses': '[]' } })
  })

  it('writes nothing to localStorage: Rust keeps its own record', async () => {
    const legacy = fakeWebStorage({ 'still-salt': 's', [MOVED_MARKER]: '{"m":1}', [CONVERTED_MARKER]: '{"c":1}' })
    const before = Object.fromEntries(legacy.data)
    invoke.mockResolvedValue({ kind: 'ready', notice: 'moved' })
    expect(await openVault(legacy)).toEqual({ kind: 'ready', notice: 'moved' })
    await restoreOldCopy(legacy)
    invoke.mockResolvedValue({ kind: 'ready', notice: 'restored' })
    expect(await restoreKeptCopy()).toEqual({ kind: 'ready', notice: 'restored' })
    expect(invoke).toHaveBeenLastCalledWith('startup_restore_v1', {})
    expect(Object.fromEntries(legacy.data)).toEqual(before)
  })

  it('passes other outcomes through, and reports a failed command as failed', async () => {
    invoke.mockResolvedValueOnce({ kind: 'file-missing', movedAt: 't' }).mockRejectedValueOnce('command not allowed')
    const legacy = fakeWebStorage()
    expect(await openVault(legacy)).toEqual({ kind: 'file-missing', movedAt: 't' })
    expect(await openVault(legacy)).toEqual({ kind: 'failed' })
    expect(legacy.data.size).toBe(0)
  })

  it('sends lone surrogates as U+FFFD, which Rust can take in', async () => {
    invoke.mockResolvedValue({ kind: 'ready' })
    await openVault(fakeWebStorage({ 'still-x': 'a\uD800b', 'still-\uDC00': 'pair \uD83D\uDD10 kept' }))
    expect(invoke).toHaveBeenCalledWith('startup_open', {
      legacy: { 'still-x': 'a\uFFFDb', 'still-\uFFFD': 'pair \uD83D\uDD10 kept' },
      marker: null,
      converted: null,
    })
  })

  it('sends Rust the conversion marker an older version left', async () => {
    invoke.mockResolvedValue({ kind: 'ready' })
    const converted = '{"convertedAt":"2026-10-13T09:00:00.000Z","fingerprint":"ab"}'
    await openVault(fakeWebStorage({ [CONVERTED_MARKER]: converted }))
    expect(invoke).toHaveBeenCalledWith('startup_open', { legacy: {}, marker: null, converted })
  })

  it('opens an old-format vault as it is, or upgrading it', async () => {
    invoke.mockResolvedValue({ kind: 'ready' })
    expect(await openOldFormat(false)).toEqual({ kind: 'ready' })
    expect(invoke).toHaveBeenLastCalledWith('startup_open_old_format', { upgrade: false })
    await openOldFormat(true)
    expect(invoke).toHaveBeenLastCalledWith('startup_open_old_format', { upgrade: true })
  })
})
