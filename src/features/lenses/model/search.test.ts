import { describe, expect, it } from 'vitest'
import type { LensView } from '@/features/vault/model/types'
import { searchVault } from './search'

const lens = (id: string, name: string, labels: string[]): LensView => ({
  id,
  name,
  createdAt: '2026-10-07T00:00:00.000Z',
  itemCount: labels.length,
  items: labels.map((label, i) => ({ id: `${id}-${i}`, label, type: 'password' })),
})

const LENSES = [
  lens('w', 'Work', ['Deploy token', 'Signing key passphrase', 'Email']),
  lens('s', 'Servers', ['SSH KEY (build box)', 'Router']),
  lens('k', 'Keychain', ['Wi-Fi']),
  lens('p', 'Personal', ['Bank']),
]

describe('searchVault', () => {
  it('matches labels, ignoring case, grouped by Lens in order', () => {
    const groups = searchVault(LENSES, '  KEY ')
    expect(groups.map((g) => [g.lens.name, g.items.map((i) => i.label)])).toEqual([
      ['Work', ['Signing key passphrase']],
      ['Servers', ['SSH KEY (build box)']],
      // The Lens name matches, so all its secrets show.
      ['Keychain', ['Wi-Fi']],
    ])
  })

  it('matches nothing for an empty search, and leaves out Lenses with no match', () => {
    expect(searchVault(LENSES, '   ')).toEqual([])
    expect(searchVault(LENSES, 'zebra')).toEqual([])
    expect(searchVault(LENSES, 'bank').map((g) => g.lens.name)).toEqual(['Personal'])
  })
})
