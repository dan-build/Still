// The vault file at start-up, kept by Rust (src-tauri/src/store.rs): whether
// there is one, and the one-time move of an older version's localStorage into
// it. This is the only code that calls the storage commands; after start-up,
// Rust's vault backend reads and writes the file itself.

import { invoke } from '@tauri-apps/api/core'

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
  importLegacy(values: StoredValues): Promise<void>
}

export const vaultFile: VaultFileApi = {
  async load() {
    const loaded = await call<{ status: FileLoad['status']; values: StoredValues | null }>('storage_load')
    return loaded.status === 'values' ? { status: 'values', values: loaded.values ?? {} } : { status: loaded.status }
  },
  importLegacy: (values) => call('storage_import_legacy', { values }),
}
