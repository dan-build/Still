import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { advisories, evaluate } from './npm-audit.mjs'

// The shape of `npm audit --json`: one entry per vulnerable package, whose
// `via` lists advisories (objects) or the packages it inherits them from (strings).
const report = {
  vulnerabilities: {
    braces: { via: [{ source: 1, name: 'braces', severity: 'high', title: 'stack exhaustion', url: 'https://github.com/advisories/GHSA-vfj7-8cjw-p6xm' }] },
    micromatch: { via: ['braces'] },
    minor: { via: [{ source: 2, name: 'minor', severity: 'moderate', title: 'small', url: 'https://github.com/advisories/GHSA-aaaa-bbbb-cccc' }] },
  },
}
const entry = { id: 'GHSA-vfj7-8cjw-p6xm', package: 'braces', reason: 'r', reviewBy: '2026-11-01' }

describe('npm audit allow-list', () => {
  it('reads each advisory once, by its GHSA id', () => {
    expect(advisories(report).map((a) => a.id)).toEqual(['GHSA-vfj7-8cjw-p6xm', 'GHSA-aaaa-bbbb-cccc'])
  })

  it('blocks a high advisory that is not on the list, and ignores moderate ones', () => {
    const { blocking } = evaluate(report, [], '2026-10-03')
    expect(blocking.map((a) => a.id)).toEqual(['GHSA-vfj7-8cjw-p6xm'])
  })

  it('allows a listed advisory until its review date, including that day', () => {
    expect(evaluate(report, [entry], '2026-11-01')).toMatchObject({ blocking: [], allowed: [{ id: entry.id }] })
  })

  it('blocks it again once the review date has passed', () => {
    const { blocking } = evaluate(report, [entry], '2026-11-02')
    expect(blocking).toMatchObject([{ id: entry.id, why: expect.stringContaining('expired') }])
  })

  it('reports list entries that no longer match anything', () => {
    expect(evaluate({ vulnerabilities: {} }, [entry], '2026-10-03').unused).toEqual([entry])
  })

  it('has a reason and a review date for every committed entry', () => {
    const allowlist = JSON.parse(readFileSync(new URL('./npm-audit-allowlist.json', import.meta.url), 'utf8'))
    for (const e of allowlist) {
      expect(e.id).toMatch(/^GHSA-/)
      expect(e.reason.length).toBeGreaterThan(20)
      expect(e.reviewBy).toMatch(/^\d{4}-\d{2}-\d{2}$/)
    }
  })
})
