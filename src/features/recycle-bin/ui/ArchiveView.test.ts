import { describe, expect, it } from 'vitest'
import { daysLeft } from './ArchiveView'

const NOW = new Date('2026-10-05T12:00:00Z')
/** The purge time of a Lens forgotten this many hours ago, as Rust sends it. */
const forgotten = (hours: number) => new Date(NOW.getTime() + (7 * 24 - hours) * 3_600_000).toISOString()

describe('daysLeft', () => {
  it('counts whole days until the 7-day purge, rounding up', () => {
    expect(daysLeft(forgotten(0), NOW)).toBe(7)
    expect(daysLeft(forgotten(1), NOW)).toBe(7)
    expect(daysLeft(forgotten(24), NOW)).toBe(6)
    expect(daysLeft(forgotten(6 * 24 + 1), NOW)).toBe(1)
  })

  it('never says less than one day: the purge waits for the next unlock', () => {
    expect(daysLeft(forgotten(7 * 24), NOW)).toBe(1)
    expect(daysLeft(forgotten(30 * 24), NOW)).toBe(1)
  })

  it('has no count for a Lens the purge keeps (its date could not be read)', () => {
    expect(daysLeft(null, NOW)).toBeNull()
    expect(daysLeft(undefined, NOW)).toBeNull()
  })
})
