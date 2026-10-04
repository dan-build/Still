import { describe, expect, it } from 'vitest'
import { fakeWebStorage as fakeStorage } from '@/test/fakeWebStorage'
import { localStorageVault } from './localStorageVault'

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
