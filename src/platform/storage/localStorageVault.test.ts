import { describe, expect, it } from 'vitest'
import { localStorageVault } from './localStorageVault'

/** A Storage whose setItem throws for the keys in `failing`. */
function fakeStorage(initial: Record<string, string>, failing: string[] = []): Storage & { data: Map<string, string> } {
  const data = new Map(Object.entries(initial))
  return {
    data,
    get length() {
      return data.size
    },
    key: (i: number) => [...data.keys()][i] ?? null,
    getItem: (key: string) => data.get(key) ?? null,
    setItem: (key: string, value: string) => {
      if (failing.includes(key)) throw new DOMException('The quota has been exceeded.', 'QuotaExceededError')
      data.set(key, value)
    },
    removeItem: (key: string) => void data.delete(key),
    clear: () => data.clear(),
  }
}

describe('localStorageVault', () => {
  it('sets and removes several values', async () => {
    const storage = fakeStorage({ a: '1', b: '2' })
    await localStorageVault(storage).write({ a: null, c: '3' })
    expect(Object.fromEntries(storage.data)).toEqual({ b: '2', c: '3' })
  })

  it('puts back what it changed when a later value fails', async () => {
    const storage = fakeStorage({ a: '1', b: '2' }, ['c'])
    await expect(localStorageVault(storage).write({ a: 'changed', b: null, c: '3' })).rejects.toThrow()
    expect(Object.fromEntries(storage.data)).toEqual({ a: '1', b: '2' })
  })
})
