import { afterEach, describe, expect, it, vi } from 'vitest'

const invoke = vi.fn()
const listen = vi.fn()
vi.mock('@tauri-apps/api/core', () => ({ invoke: (...args: unknown[]) => invoke(...args) }))
vi.mock('@tauri-apps/api/event', () => ({ listen: (...args: unknown[]) => listen(...args) }))

import { onAutoLocked, reportActivity } from './session'

afterEach(() => {
  invoke.mockReset()
  listen.mockReset()
})

describe('auto-lock from the page', () => {
  it('reports activity with vault_touch and ignores failures', async () => {
    invoke.mockRejectedValue('failed')
    expect(() => reportActivity()).not.toThrow()
    expect(invoke).toHaveBeenCalledWith('vault_touch')
    await Promise.resolve()
  })

  it('passes the reason from the vault-locked event, and stops listening', async () => {
    const unlisten = vi.fn()
    let handler!: (event: { payload: string }) => void
    listen.mockImplementation(async (name: string, h: typeof handler) => {
      expect(name).toBe('vault-locked')
      handler = h
      return unlisten
    })
    const reasons: string[] = []
    const stop = onAutoLocked((reason) => reasons.push(reason))
    await vi.waitFor(() => expect(handler).toBeDefined())
    handler({ payload: 'sleep' })
    expect(reasons).toEqual(['sleep'])
    stop()
    expect(unlisten).toHaveBeenCalledOnce()
  })

  it('still stops listening when stopped before listening has started', async () => {
    const unlisten = vi.fn()
    let started!: (u: () => void) => void
    listen.mockReturnValue(new Promise((resolve) => (started = resolve)))
    const stop = onAutoLocked(() => {})
    stop()
    started(unlisten)
    await vi.waitFor(() => expect(unlisten).toHaveBeenCalledOnce())
  })
})
