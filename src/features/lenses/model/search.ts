import type { ItemView, LensView } from '@/features/vault/model/types'

export interface SearchGroup {
  lens: LensView
  items: ItemView[]
}

/**
 * Secrets matching a search, grouped by Lens in the sidebar's order. It looks
 * at labels, a password's username and website, and Lens names: values stay
 * encrypted and are never searched.
 * A Lens whose name matches shows all its secrets. Case doesn't matter, and an
 * empty search matches nothing.
 */
export function searchVault(lenses: readonly LensView[], query: string): SearchGroup[] {
  const q = query.trim().toLocaleLowerCase()
  if (q === '') return []
  const groups: SearchGroup[] = []
  for (const lens of lenses) {
    const matches = (i: ItemView) => [i.label, i.username, i.url].some((text) => text?.toLocaleLowerCase().includes(q))
    const items = lens.name.toLocaleLowerCase().includes(q) ? lens.items : lens.items.filter(matches)
    if (items.length > 0) groups.push({ lens, items })
  }
  return groups
}
