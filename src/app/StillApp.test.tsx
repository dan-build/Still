// @vitest-environment happy-dom
//
// The start-up screens. The start-up logic itself is tested in
// src-tauri/src/startup.rs; here it's replaced, and so is the app.

import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { createElement } from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { Startup } from '@/platform/tauri/startup'

const startup = vi.hoisted(() => ({
  open: vi.fn<() => Promise<Startup>>(),
  move: vi.fn<() => Promise<Startup>>(),
  oldFormat: vi.fn<() => Promise<Startup>>(),
  restore: vi.fn<() => Promise<Startup>>(),
}))
vi.mock('@/platform/tauri/startup', () => ({
  openVault: startup.open,
  restoreOldCopy: startup.move,
  openOldFormat: startup.oldFormat,
  restoreKeptCopy: startup.restore,
}))
vi.mock('./App', () => ({
  default: ({ notice }: { notice?: string }) => createElement('p', null, `the app${notice ? ` (${notice})` : ''}`),
}))

import StillApp from './StillApp'

afterEach(() => {
  cleanup()
  startup.open.mockReset()
  startup.move.mockReset()
  startup.oldFormat.mockReset()
  startup.restore.mockReset()
})

describe('start-up screens', () => {
  it('shows the app once the vault storage is open, with any notice', async () => {
    startup.open.mockResolvedValue({ kind: 'ready', notice: 'moved' })
    render(createElement(StillApp))
    await screen.findByText('the app (moved)')
  })

  it('stops when another copy of Still is open', async () => {
    startup.open.mockResolvedValue({ kind: 'already-open' })
    render(createElement(StillApp))
    await screen.findByText('Still is already open')
    expect(screen.queryByRole('button')).toBeNull()
  })

  it('explains a damaged vault file without offering to replace it', async () => {
    startup.open.mockResolvedValue({ kind: 'unreadable' })
    render(createElement(StillApp))
    await screen.findByText("Still can't read its vault file")
    expect(screen.getByText(/from a newer version of Still/)).toBeTruthy()
    expect(screen.queryByRole('button')).toBeNull()
  })

  it('uses the older copy for a missing file only when asked', async () => {
    startup.open.mockResolvedValue({ kind: 'file-missing', movedAt: '2026-10-05T10:00:00.000Z' })
    startup.move.mockResolvedValue({ kind: 'ready', notice: 'moved' })
    render(createElement(StillApp))
    await screen.findByText('Your vault file is missing')
    expect(startup.move).not.toHaveBeenCalled()

    fireEvent.click(screen.getByRole('button', { name: 'Use the older copy' }))
    await screen.findByText('the app (moved)')
    expect(startup.move).toHaveBeenCalledOnce()
  })

  it('opens an old-format vault after an upgrade only when asked', async () => {
    startup.open.mockResolvedValue({ kind: 'old-format', convertedAt: '2026-10-13T09:00:00.000Z' })
    startup.oldFormat.mockResolvedValue({ kind: 'ready' })
    render(createElement(StillApp))
    await screen.findByText('This vault is in the old format')
    expect(screen.getByText(/older copy, or one that was changed/)).toBeTruthy()
    expect(startup.oldFormat).not.toHaveBeenCalled()

    expect(screen.getByRole('button', { name: 'Open and upgrade it' })).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: 'Open anyway' }))
    await screen.findByText('the app')
    expect(startup.oldFormat).toHaveBeenCalledWith(expect.anything(), false)
  })

  it('can open and upgrade an old-format vault instead', async () => {
    startup.open.mockResolvedValue({ kind: 'old-format', convertedAt: '2026-10-13T09:00:00.000Z' })
    startup.oldFormat.mockResolvedValue({ kind: 'ready' })
    render(createElement(StillApp))
    fireEvent.click(await screen.findByRole('button', { name: 'Open and upgrade it' }))
    await screen.findByText('the app')
    expect(startup.oldFormat).toHaveBeenCalledWith(expect.anything(), true)
  })

  it('offers the kept copy for an unreadable file only when there is one, and only when asked', async () => {
    startup.open.mockResolvedValue({ kind: 'unreadable', canRestore: true })
    startup.restore.mockResolvedValue({ kind: 'ready', notice: 'restored' })
    render(createElement(StillApp))
    await screen.findByText(/Still kept an earlier copy/)
    expect(startup.restore).not.toHaveBeenCalled()

    fireEvent.click(screen.getByRole('button', { name: 'Use the kept copy' }))
    await screen.findByText('the app (restored)')
    expect(startup.restore).toHaveBeenCalledOnce()
  })

  it('offers to try again when the file could not be opened', async () => {
    startup.open.mockResolvedValueOnce({ kind: 'failed' }).mockResolvedValueOnce({ kind: 'ready' })
    render(createElement(StillApp))
    fireEvent.click(await screen.findByRole('button', { name: 'Try again' }))
    await screen.findByText('the app')
  })
})
