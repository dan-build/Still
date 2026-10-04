// VaultStorage on the webview's localStorage, where versions before the vault
// file kept the vault. localStorage can't write several keys atomically, so a
// failed write puts back what it already changed, as well as it can.

import type { VaultStorage } from './backend'

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
