// Runs `npm audit` and fails on any high or critical advisory, in any
// dependency (dev tools included, since they build what ships), unless
// scripts/npm-audit-allowlist.json lists it with a reason. An entry only
// counts until its reviewBy date; after that it blocks again until someone
// looks at it. Mirrors the reasoned ignores in .cargo/audit.toml.

import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

const BLOCKING = new Set(['high', 'critical'])

/** The advisories in an `npm audit --json` report, one per id. */
export function advisories(report) {
  const byId = new Map()
  for (const vulnerability of Object.values(report.vulnerabilities ?? {})) {
    for (const via of vulnerability.via) {
      if (typeof via !== 'object') continue
      const id = via.url?.match(/GHSA-[\w-]+/)?.[0] ?? String(via.source)
      byId.set(id, { id, name: via.name, severity: via.severity, title: via.title })
    }
  }
  return [...byId.values()]
}

/**
 * Splits a report's advisories into those that block and those allowed, and
 * lists allow-list entries that no longer match anything. `today` is YYYY-MM-DD.
 */
export function evaluate(report, allowlist, today) {
  const blocking = []
  const allowed = []
  for (const advisory of advisories(report)) {
    if (!BLOCKING.has(advisory.severity)) continue
    const entry = allowlist.find((e) => e.id === advisory.id)
    if (!entry) blocking.push({ ...advisory, why: 'not on the allow-list' })
    else if (entry.reviewBy < today) blocking.push({ ...advisory, why: `allow-list entry expired on ${entry.reviewBy}; review it` })
    else allowed.push({ ...advisory, entry })
  }
  const found = new Set(advisories(report).map((a) => a.id))
  const unused = allowlist.filter((e) => !found.has(e.id))
  return { blocking, allowed, unused }
}

function runAudit() {
  try {
    return execFileSync('npm', ['audit', '--json'], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 })
  } catch (error) {
    // npm audit exits non-zero when it finds anything; the report is still on stdout.
    if (error.stdout) return error.stdout
    throw error
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const allowlist = JSON.parse(readFileSync(new URL('./npm-audit-allowlist.json', import.meta.url), 'utf8'))
  const today = new Date().toISOString().slice(0, 10)
  const { blocking, allowed, unused } = evaluate(JSON.parse(runAudit()), allowlist, today)

  for (const a of allowed) console.log(`allowed until ${a.entry.reviewBy}: ${a.id} (${a.name}, ${a.severity}): ${a.entry.reason}`)
  for (const e of unused) console.log(`::warning::${e.id} is on the npm audit allow-list but no longer reported; remove it.`)
  for (const a of blocking) console.error(`::error::${a.id} (${a.name}, ${a.severity}): ${a.title}. Blocking: ${a.why}.`)
  if (blocking.length > 0) process.exit(1)
  console.log('npm audit: no blocking advisories.')
}
