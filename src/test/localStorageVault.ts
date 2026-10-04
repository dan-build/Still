// VaultStorage on localStorage, for UI tests that check the stored values
// there (the app itself stores them in the vault file). localStorage can't
// write several keys atomically, so a failed write puts back what it already
// changed, as well as it can.

import type { VaultStorage } from '@/platform/storage/backend'

export function localStorageVault(storage: Storage): VaultStorage {
  return {
    get: (key) => storage.getItem(key),
    async write(changes) {
      const done: [string, string | null][] = []
      try {
        for (const [key, value] of Object.entries(changes)) {
          const previous = storage.getItem(key)
          if (value === null) storage.removeItem(key)
          else storage.setItem(key, value)
          done.push([key, previous])
        }
      } catch (error) {
        for (const [key, previous] of done.reverse()) {
          try {
            if (previous === null) storage.removeItem(key)
            else storage.setItem(key, previous)
          } catch {
            // Best effort.
          }
        }
        throw error
      }
    },
  }
}
