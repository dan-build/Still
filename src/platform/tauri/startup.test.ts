import { afterEach, describe, expect, it, vi } from 'vitest'
import { fakeWebStorage } from '@/test/fakeWebStorage'

const invoke = vi.fn()
vi.mock('@tauri-apps/api/core', () => ({ invoke: (...args: unknown[]) => invoke(...args) }))

import { MOVED_MARKER, openVault, restoreOldCopy } from './startup'

afterEach(() => invoke.mockReset())

// The decisions themselves are Rust's, tested in src-tauri/src/startup.rs.
describe('start-up, seen from the page', () => {
  it('sends Rust the old values (not the marker or other apps\' keys) and the marker', async () => {
    invoke.mockResolvedValue({ kind: 'ready' })
    const legacy = fakeWebStorage({ 'still-salt': 's', 'still-lenses': '[]', [MOVED_MARKER]: '{"m":1}', 'unrelated-app-key': 'x' })
    expect(await openVault(legacy)).toEqual({ kind: 'ready' })
    expect(invoke).toHaveBeenCalledWith('startup_open', { legacy: { 'still-salt': 's', 'still-lenses': '[]' }, marker: '{"m":1}' })

    await restoreOldCopy(legacy)
    expect(invoke).toHaveBeenLastCalledWith('startup_use_old_copy', { legacy: { 'still-salt': 's', 'still-lenses': '[]' } })
  })

  it('writes the marker Rust asks for, and keeps everything else in localStorage as it was', async () => {
    const marker = '{"movedAt":"2026-10-05T10:00:00.000Z","fingerprint":"ab"}'
    invoke.mockResolvedValue({ kind: 'ready', notice: 'moved', marker })
    const legacy = fakeWebStorage({ 'still-salt': 's' })
    expect(await openVault(legacy)).toEqual({ kind: 'ready', notice: 'moved' })
    expect(Object.fromEntries(legacy.data)).toEqual({ 'still-salt': 's', [MOVED_MARKER]: marker })
  })

  it('still opens the vault if the marker can\'t be written', async () => {
    invoke.mockResolvedValue({ kind: 'ready', notice: 'moved', marker: '{}' })
    const legacy = fakeWebStorage({ 'still-salt': 's' }, [MOVED_MARKER])
    expect(await openVault(legacy)).toEqual({ kind: 'ready', notice: 'moved' })
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
    })
  })
})
