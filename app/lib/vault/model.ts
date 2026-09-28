// Pure operations on the stored vault lists. No crypto, no storage, no keys:
// Lenses stay exactly as stored (including their wrapped key), so saving an
// unchanged vault writes back the same bytes and unreadable Lenses survive.

import type { PersistedItem, PersistedLens, VaultLists } from './types'

export const RECYCLE_DAYS = 7
const DAY_MS = 24 * 60 * 60 * 1000

export class VaultDataError extends Error {}

/** Parses a stored Lens list. A missing value is an empty list; anything else unreadable throws. */
export function parseLensList(raw: string | null): PersistedLens[] {
  if (raw === null) return []
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    throw new VaultDataError('Stored Lens list is not valid JSON')
  }
  if (!Array.isArray(parsed)) throw new VaultDataError('Stored Lens list is not a list')
  return parsed as PersistedLens[]
}

export function serializeLensList(list: PersistedLens[]): string {
  return JSON.stringify(list)
}

export function addLens(state: VaultLists, lens: PersistedLens): VaultLists {
  return { ...state, lenses: [lens, ...state.lenses] }
}

export function setItems(state: VaultLists, lensId: string, items: PersistedItem[]): VaultLists {
  return {
    ...state,
    lenses: state.lenses.map((lens) => (lens.id === lensId ? { ...lens, items, itemCount: items.length } : lens)),
  }
}

export function forgetLens(state: VaultLists, lensId: string, now: Date): VaultLists {
  const lens = state.lenses.find((l) => l.id === lensId)
  if (!lens) return state
  return {
    lenses: state.lenses.filter((l) => l.id !== lensId),
    bin: [{ ...lens, deletedAt: now.toISOString() }, ...state.bin],
  }
}

export function restoreLens(state: VaultLists, lensId: string): VaultLists {
  const recycled = state.bin.find((l) => l.id === lensId)
  if (!recycled) return state
  const { deletedAt: _deletedAt, ...lens } = recycled
  return { lenses: [lens, ...state.lenses], bin: state.bin.filter((l) => l.id !== lensId) }
}

export function deleteLensForever(state: VaultLists, lensId: string): VaultLists {
  return { ...state, bin: state.bin.filter((l) => l.id !== lensId) }
}

/** Removes bin entries deleted more than RECYCLE_DAYS ago (same rule as v0.1.0). */
export function purgeExpired(state: VaultLists, now: Date): VaultLists {
  const cutoff = new Date(now.getTime() - RECYCLE_DAYS * DAY_MS)
  return { ...state, bin: state.bin.filter((l) => new Date(l.deletedAt ?? '') > cutoff) }
}
