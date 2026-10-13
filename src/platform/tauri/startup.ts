// Where the vault comes from when Still starts. Rust decides (src-tauri/src/startup.rs):
// the vault file, or, once, the localStorage of versions before the file. Only
// the page can read that localStorage, so this sends Rust what an older version
// left there and writes the marker Rust asks for. The old copy itself is never
// changed or deleted.

import { invoke } from '@tauri-apps/api/core'

/** Set in localStorage once the vault has moved to the file. */
export const MOVED_MARKER = 'still-moved-to-file'
/** Set in localStorage once the vault was converted to format v2 (vaultApi.ts writes it). */
export const CONVERTED_MARKER = 'still-converted-v2'

export type Startup =
  | { kind: 'ready'; notice?: 'moved' | 'old-copy-changed' | 'restored' }
  | { kind: 'already-open' }
  /** canRestore: the v1 file a conversion kept can be put back. */
  | { kind: 'unreadable'; canRestore?: boolean }
  /** The file is in the old format, but the vault was converted on convertedAt: it opens only if the user says so. */
  | { kind: 'old-format'; convertedAt: string }
  | { kind: 'file-missing'; movedAt: string }
  | { kind: 'failed' }

/**
 * A lone UTF-16 surrogate becomes U+FFFD: Rust can't take one in (Still never
 * wrote one), and one would otherwise stop Still from starting at all.
 */
function wellFormed(text: string): string {
  // A loop, not a regex: lookbehind needs Safari 16.4, and the app runs on 15.4.
  let out = ''
  for (let i = 0; i < text.length; i++) {
    const unit = text.charCodeAt(i)
    const high = unit >= 0xd800 && unit <= 0xdbff
    const nextIsLow = i + 1 < text.length && text.charCodeAt(i + 1) >= 0xdc00 && text.charCodeAt(i + 1) <= 0xdfff
    if (high && nextIsLow) {
      out += text[i] + text[i + 1]
      i++
    } else if (unit >= 0xd800 && unit <= 0xdfff) {
      out += '\uFFFD'
    } else {
      out += text[i]
    }
  }
  return out
}

/** Every value an older version stored (they all start with "still-"), except the two markers. */
function legacyValues(legacy: Storage): Record<string, string> {
  const values: Record<string, string> = {}
  for (let i = 0; i < legacy.length; i++) {
    const key = legacy.key(i)
    if (key === null || !key.startsWith('still-') || key === MOVED_MARKER || key === CONVERTED_MARKER) continue
    const value = legacy.getItem(key)
    if (value !== null) values[wellFormed(key)] = wellFormed(value)
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
  const marker = legacy.getItem(MOVED_MARKER)
  const converted = legacy.getItem(CONVERTED_MARKER)
  return run(
    'startup_open',
    {
      legacy: legacyValues(legacy),
      marker: marker === null ? null : wellFormed(marker),
      converted: converted === null ? null : wellFormed(converted),
    },
    legacy,
  )
}

/** The user's choice when the moved vault file has gone: bring back the older copy. */
export function restoreOldCopy(legacy: Storage): Promise<Startup> {
  return run('startup_use_old_copy', { legacy: legacyValues(legacy) }, legacy)
}

/** The user's choice for an old-format vault file: open it as it is (it isn't converted this time). */
export function openOldFormat(legacy: Storage): Promise<Startup> {
  return run('startup_open_old_format', {}, legacy)
}

/**
 * The user's choice for an unreadable vault file: put back the v1 file the
 * conversion kept. Going back was their choice, so the conversion marker goes.
 */
export async function restoreKeptCopy(legacy: Storage): Promise<Startup> {
  const startup = await run('startup_restore_v1', {}, legacy)
  if (startup.kind === 'ready') {
    try {
      legacy.removeItem(CONVERTED_MARKER)
    } catch {
      // Without this, the next start asks before opening the restored copy.
    }
  }
  return startup
}
