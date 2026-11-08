// Where the vault comes from when Still starts. Rust decides (src-tauri/src/startup.rs):
// the vault file, or, once, the localStorage of versions before the file. Only
// the page can read that localStorage, so this sends Rust what an older version
// left there. Rust keeps its own record (state.json); the two markers versions
// up to 0.8 kept in localStorage are sent too, and taken into it once. Nothing
// in localStorage is ever written, changed or deleted.

import { invoke } from '@tauri-apps/api/core'

/** Set in localStorage by versions up to 0.8, once the vault had moved to the file. */
export const MOVED_MARKER = 'still-moved-to-file'
/** Set in localStorage by versions up to 0.8, once the vault was converted to format v2. */
export const CONVERTED_MARKER = 'still-converted-v2'

export type Startup =
  | { kind: 'ready'; notice?: 'moved' | 'old-copy-changed' | 'restored' }
  | { kind: 'already-open' }
  /** canRestore: the v1 file a conversion kept can be put back. */
  | { kind: 'unreadable'; canRestore?: boolean }
  /** The file is in the old format, but the vault was converted on convertedAt: it opens only if the user says so. */
  | { kind: 'old-format'; convertedAt: string }
  | { kind: 'file-missing'; movedAt: string }
  /**
   * The vault file isn't the one Still saved last (an older copy put back, say): it opens only if
   * the user says so. samePassword false: it may be from before a password change.
   */
  | { kind: 'replaced'; samePassword: boolean }
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

async function run(command: string, args: Record<string, unknown> = {}): Promise<Startup> {
  try {
    return await invoke<Startup>(command, args)
  } catch {
    return { kind: 'failed' }
  }
}

/** Opens the vault file, moving an older version's vault into it the first time. */
export function openVault(legacy: Storage): Promise<Startup> {
  const marker = legacy.getItem(MOVED_MARKER)
  const converted = legacy.getItem(CONVERTED_MARKER)
  return run('startup_open', {
    legacy: legacyValues(legacy),
    marker: marker === null ? null : wellFormed(marker),
    converted: converted === null ? null : wellFormed(converted),
  })
}

/** The user's choice when the moved vault file has gone: bring back the older copy. */
export function restoreOldCopy(legacy: Storage): Promise<Startup> {
  return run('startup_use_old_copy', { legacy: legacyValues(legacy) })
}

/**
 * The user's choice for an old-format vault file: open it as it is (it isn't
 * converted), or open and upgrade it, making that copy the vault from now on.
 */
export function openOldFormat(upgrade: boolean): Promise<Startup> {
  return run('startup_open_old_format', { upgrade })
}

/**
 * The user's choice for a vault file that isn't the one Still saved last: open
 * it, making it the vault from now on. Start-up then runs again, for anything
 * else it has to say.
 */
export async function openReplaced(legacy: Storage): Promise<Startup> {
  const accepted = await run('startup_open_replaced')
  return accepted.kind === 'ready' ? openVault(legacy) : accepted
}

/**
 * The user's choice for a vault file that can't be opened: put back the newest
 * copy Still kept.
 */
export function restoreKeptCopy(): Promise<Startup> {
  return run('startup_restore_v1')
}
