// Where the vault comes from when Still starts: the vault file, or, once, the
// localStorage of versions before the file. The old copy is never changed or
// deleted; a marker in localStorage records that the move happened.
//
// - A vault file: use it. If an older version changed the old copy since the
//   move, say so once.
// - No file, old data, no marker: copy the old values into a new file,
//   unchanged (Rust checks them back), then set the marker.
// - No file, but the marker: the file was moved and has gone missing. Don't
//   quietly bring back the older copy; let the user choose.
// - Nothing anywhere: a new install; the file appears with the first vault.

import { VaultFileError, type StoredValues, type VaultFileApi } from '@/platform/tauri/vaultFile'

/** Set in localStorage once the vault has moved to the file. */
export const MOVED_MARKER = 'still-moved-to-file'

interface Moved {
  movedAt: string
  /** SHA-256 of the values that were moved, to notice later changes by older versions. */
  fingerprint: string
}

export type Startup =
  /** The vault file is ready; Rust's vault backend reads and writes it from here. */
  | { kind: 'ready'; notice?: 'moved' | 'old-copy-changed' }
  | { kind: 'already-open' }
  | { kind: 'unreadable' }
  | { kind: 'file-missing'; movedAt: string }
  | { kind: 'failed' }

/** Every value an older version stored (they all start with "still-"), except the marker. */
export function legacyValues(legacy: Storage): StoredValues {
  const values: StoredValues = {}
  for (let i = 0; i < legacy.length; i++) {
    const key = legacy.key(i)
    if (key === null || !key.startsWith('still-') || key === MOVED_MARKER) continue
    const value = legacy.getItem(key)
    if (value !== null) values[key] = value
  }
  return values
}

export async function fingerprint(values: StoredValues): Promise<string> {
  const canonical = JSON.stringify(Object.keys(values).sort().map((key) => [key, values[key]]))
  const digest = await globalThis.crypto.subtle.digest('SHA-256', new TextEncoder().encode(canonical))
  return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, '0')).join('')
}

function readMarker(legacy: Storage): Moved | null {
  try {
    const marker = JSON.parse(legacy.getItem(MOVED_MARKER) ?? 'null')
    return typeof marker?.movedAt === 'string' && typeof marker?.fingerprint === 'string' ? marker : null
  } catch {
    return null
  }
}

async function setMarker(legacy: Storage, values: StoredValues, movedAt: string) {
  try {
    const marker: Moved = { movedAt, fingerprint: await fingerprint(values) }
    legacy.setItem(MOVED_MARKER, JSON.stringify(marker))
  } catch {
    // The move itself succeeded; without the marker only the downgrade notice is lost.
  }
}

export async function openVaultStorage(file: VaultFileApi, legacy: Storage, now: () => Date = () => new Date()): Promise<Startup> {
  let loaded
  try {
    loaded = await file.load()
  } catch {
    return { kind: 'failed' }
  }
  if (loaded.status === 'already-open') return { kind: 'already-open' }
  if (loaded.status === 'unreadable') return { kind: 'unreadable' }

  const marker = readMarker(legacy)
  if (loaded.status === 'values') {
    if (marker && marker.fingerprint !== (await fingerprint(legacyValues(legacy)))) {
      // Show once: the marker now matches the old copy as it is.
      await setMarker(legacy, legacyValues(legacy), marker.movedAt)
      return { kind: 'ready', notice: 'old-copy-changed' }
    }
    return { kind: 'ready' }
  }

  if (marker) return { kind: 'file-missing', movedAt: marker.movedAt }
  const values = legacyValues(legacy)
  if (Object.keys(values).length === 0) return { kind: 'ready' }
  return moveOldCopy(file, legacy, values, now)
}

/**
 * Copies the old values into a new vault file, then sets the marker. Also the
 * user's choice on the file-missing screen.
 */
export async function moveOldCopy(
  file: VaultFileApi,
  legacy: Storage,
  values: StoredValues = legacyValues(legacy),
  now: () => Date = () => new Date(),
): Promise<Startup> {
  try {
    await file.importLegacy(values)
  } catch (error) {
    if (error instanceof VaultFileError && error.code === 'already-open') return { kind: 'already-open' }
    return { kind: 'failed' }
  }
  await setMarker(legacy, values, now().toISOString())
  return { kind: 'ready', notice: 'moved' }
}
