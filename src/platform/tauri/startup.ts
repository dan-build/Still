// Where the vault comes from when Still starts. Rust decides (src-tauri/src/startup.rs):
// the vault file, or, once, the localStorage of versions before the file. Only
// the page can read that localStorage, so this sends Rust what an older version
// left there and writes the marker Rust asks for. The old copy itself is never
// changed or deleted.

import { invoke } from '@tauri-apps/api/core'

/** Set in localStorage once the vault has moved to the file. */
export const MOVED_MARKER = 'still-moved-to-file'

export type Startup =
  | { kind: 'ready'; notice?: 'moved' | 'old-copy-changed' }
  | { kind: 'already-open' }
  | { kind: 'unreadable' }
  | { kind: 'file-missing'; movedAt: string }
  | { kind: 'failed' }

/** Every value an older version stored (they all start with "still-"), except the marker. */
function legacyValues(legacy: Storage): Record<string, string> {
  const values: Record<string, string> = {}
  for (let i = 0; i < legacy.length; i++) {
    const key = legacy.key(i)
    if (key === null || !key.startsWith('still-') || key === MOVED_MARKER) continue
    const value = legacy.getItem(key)
    if (value !== null) values[key] = value
  }
  return values
}

async function run(command: string, args: Record<string, unknown>, legacy: Storage): Promise<Startup> {
  let result: Startup & { marker?: string }
  try {
    result = await invoke(command, args)
  } catch {
    return { kind: 'failed' }
  }
  const { marker, ...startup } = result
  if (marker !== undefined) {
    try {
      legacy.setItem(MOVED_MARKER, marker)
    } catch {
      // The move itself succeeded; without the marker only the downgrade notice is lost.
    }
  }
  return startup
}

/** Opens the vault file, moving an older version's vault into it the first time. */
export function openVault(legacy: Storage): Promise<Startup> {
  return run('startup_open', { legacy: legacyValues(legacy), marker: legacy.getItem(MOVED_MARKER) }, legacy)
}

/** The user's choice when the moved vault file has gone: bring back the older copy. */
export function restoreOldCopy(legacy: Storage): Promise<Startup> {
  return run('startup_use_old_copy', { legacy: legacyValues(legacy) }, legacy)
}
