import { describe, expect, it } from 'vitest'
import { daysLeft } from './ArchiveView'

const NOW = new Date('2026-10-05T12:00:00Z')
const ago = (hours: number) => new Date(NOW.getTime() - hours * 3_600_000).toISOString()

describe('daysLeft', () => {
  it('counts whole days until the 7-day purge, rounding up', () => {
    expect(daysLeft(ago(0), NOW)).toBe(7)
    expect(daysLeft(ago(1), NOW)).toBe(7)
    expect(daysLeft(ago(24), NOW)).toBe(6)
    expect(daysLeft(ago(6 * 24 + 1), NOW)).toBe(1)
  })

  it('never says less than one day: the purge waits for the next unlock', () => {
    expect(daysLeft(ago(7 * 24), NOW)).toBe(1)
    expect(daysLeft(ago(30 * 24), NOW)).toBe(1)
  })

  it('treats a missing or unreadable time as a full 7 days', () => {
    expect(daysLeft(undefined, NOW)).toBe(7)
    expect(daysLeft('not a date', NOW)).toBe(7)
  })
})
