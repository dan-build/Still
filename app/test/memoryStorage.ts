// An in-memory stand-in for localStorage in vault-layer tests.

import type { KeyValueStorage } from '../lib/vault/backend'

export class MemoryStorage implements KeyValueStorage {
  readonly data = new Map<string, string>()
  /** Set to make every setItem throw, like a full localStorage. */
  failWrites = false
  writes: string[] = []

  constructor(initial: Record<string, string | null> = {}) {
    for (const [key, value] of Object.entries(initial)) if (value !== null) this.data.set(key, value)
  }

  getItem(key: string) {
    return this.data.get(key) ?? null
  }

  setItem(key: string, value: string) {
    if (this.failWrites) throw new DOMException('The quota has been exceeded.', 'QuotaExceededError')
    this.writes.push(key)
    this.data.set(key, value)
  }

  removeItem(key: string) {
    this.data.delete(key)
  }
}
