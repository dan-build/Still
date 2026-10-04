// The vault file, kept by Rust (src-tauri/src/store.rs). This is the only
// code that calls the storage commands.

import { invoke } from '@tauri-apps/api/core'
import type { VaultStorage } from '@/platform/storage/backend'

export type StoredValues = Record<string, string>

export type FileLoad =
  | { status: 'values'; values: StoredValues }
  | { status: 'nothing' | 'unreadable' | 'already-open' }

/** A failed storage command: unreadable-data, exists, already-open or failed. */
export class VaultFileError extends Error {
  constructor(readonly code: string) {
    super(code)
  }
}

async function call<T>(command: string, args?: Record<string, unknown>): Promise<T> {
  try {
    return await invoke<T>(command, args)
  } catch (error) {
    throw new VaultFileError(typeof error === 'string' ? error : 'failed')
  }
}

export interface VaultFileApi {
  load(): Promise<FileLoad>
  write(changes: Record<string, string | null>): Promise<void>
  importLegacy(values: StoredValues): Promise<void>
}

export const vaultFile: VaultFileApi = {
  async load() {
    const loaded = await call<{ status: FileLoad['status']; values: StoredValues | null }>('storage_load')
    return loaded.status === 'values' ? { status: 'values', values: loaded.values ?? {} } : { status: loaded.status }
  },
  write: (changes) => call('storage_write', { changes }),
  importLegacy: (values) => call('storage_import_legacy', { values }),
}

/** VaultStorage over the file: reads from what was loaded, writes through Rust first. */
export function fileVaultStorage(file: VaultFileApi, loaded: StoredValues): VaultStorage {
  const values = new Map(Object.entries(loaded))
  return {
    get: (key) => values.get(key) ?? null,
    async write(changes) {
      await file.write(changes)
      for (const [key, value] of Object.entries(changes)) {
        if (value === null) values.delete(key)
        else values.set(key, value)
      }
    },
  }
}
