// An in-memory VaultStorage for vault-layer tests. Like the vault file, each
// write lands entirely or not at all.

import type { VaultStorage } from '@/platform/storage/backend'

export class MemoryStorage implements VaultStorage {
  readonly data = new Map<string, string>()
  /** Set to make every write fail, like a full or read-only disk. */
  failWrites = false
  /** Writes that touch any of these keys fail. */
  failKeys = new Set<string>()
  /** The keys of each write, in order. */
  writes: string[][] = []
  /** Set to a promise to hold writes until it resolves, like a slow disk. */
  gate: Promise<void> | undefined

  constructor(initial: Record<string, string | null> = {}) {
    for (const [key, value] of Object.entries(initial)) if (value !== null) this.data.set(key, value)
  }

  get(key: string) {
    return this.data.get(key) ?? null
  }

  async write(changes: Record<string, string | null>) {
    await this.gate
    const keys = Object.keys(changes)
    if (this.failWrites || keys.some((key) => this.failKeys.has(key))) throw new Error('The disk refused the write')
    this.writes.push(keys)
    for (const [key, value] of Object.entries(changes)) {
      if (value === null) this.data.delete(key)
      else this.data.set(key, value)
    }
  }

  // ---- for setting up tests, outside the backend ----

  getItem(key: string) {
    return this.get(key)
  }

  setItem(key: string, value: string) {
    this.data.set(key, value)
  }
}
