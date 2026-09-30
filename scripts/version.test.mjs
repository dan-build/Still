import { cpSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { checkVersions, readVersions, setVersion } from './version.mjs'

const repo = join(fileURLToPath(import.meta.url), '..', '..')
const FILES = ['package.json', 'package-lock.json', 'Cargo.toml', 'Cargo.lock', 'src-tauri/tauri.conf.json', 'CHANGELOG.md']

/** A scratch copy of the real version sources. */
function copyOfRepo() {
  const dir = mkdtempSync(join(tmpdir(), 'still-version-'))
  for (const file of FILES) cpSync(join(repo, file), join(dir, file), { recursive: true })
  return dir
}

const edit = (dir, file, change) => writeFileSync(join(dir, file), change(readFileSync(join(dir, file), 'utf8')))

describe('the real repository', () => {
  it('has one version everywhere', () => {
    expect(new Set(Object.values(readVersions(repo))).size).toBe(1)
    expect(checkVersions(repo)).toEqual([])
  })
})

describe('setVersion', () => {
  it('updates every source and nothing else', () => {
    const dir = copyOfRepo()
    const before = Object.fromEntries(FILES.map((f) => [f, readFileSync(join(dir, f), 'utf8')]))
    setVersion(dir, '9.8.7')

    expect(new Set(Object.values(readVersions(dir)))).toEqual(new Set(['9.8.7']))
    for (const file of FILES) {
      const changed = readFileSync(join(dir, file), 'utf8')
      if (file === 'CHANGELOG.md') {
        expect(changed).toBe(before[file])
        continue
      }
      // Only version lines may differ.
      const diff = changed.split('\n').filter((line, i) => line !== before[file].split('\n')[i])
      expect(diff.length).toBeGreaterThan(0)
      for (const line of diff) expect(line).toMatch(/"?version"?\s*[:=]\s*"9\.8\.7"/)
    }
  })

  it('leaves other packages in Cargo.lock alone', () => {
    const dir = copyOfRepo()
    const other = (text) => text.match(/\[\[package\]\]\nname = "tauri"\nversion = "[^"]+"/)[0]
    const before = other(readFileSync(join(dir, 'Cargo.lock'), 'utf8'))
    setVersion(dir, '9.8.7')
    expect(other(readFileSync(join(dir, 'Cargo.lock'), 'utf8'))).toBe(before)
  })

  it('updates every workspace package in Cargo.lock', () => {
    const dir = copyOfRepo()
    setVersion(dir, '9.8.7')
    const lock = readFileSync(join(dir, 'Cargo.lock'), 'utf8')
    for (const name of ['still', 'still-core']) {
      expect(lock).toContain(`[[package]]\nname = "${name}"\nversion = "9.8.7"`)
    }
  })

  it('refuses something that is not a version', () => {
    expect(() => setVersion(copyOfRepo(), 'v1.2')).toThrow('Not a version')
  })
})

describe('checkVersions with a tag', () => {
  function releasable(version) {
    const dir = copyOfRepo()
    setVersion(dir, version)
    edit(dir, 'CHANGELOG.md', (t) => t.replace('## [Unreleased]', `## [Unreleased]\n\n## [${version}] - 2026-10-01`))
    return dir
  }

  it('passes when every source matches the tag and CHANGELOG has the section', () => {
    expect(checkVersions(releasable('9.8.7'), 'v9.8.7')).toEqual([])
  })

  it('fails when the tag does not match', () => {
    expect(checkVersions(releasable('9.8.7'), 'v9.8.8').join('\n')).toMatch(/is 9\.8\.7, but the tag is v9\.8\.8/)
  })

  it('fails when one source was missed', () => {
    const dir = releasable('9.8.7')
    edit(dir, 'src-tauri/tauri.conf.json', (t) => t.replace('"version": "9.8.7"', '"version": "9.8.6"'))
    const problems = checkVersions(dir, 'v9.8.7').join('\n')
    expect(problems).toMatch(/disagree/)
    expect(problems).toMatch(/tauri\.conf\.json is 9\.8\.6/)
  })

  it('fails without a dated CHANGELOG section', () => {
    const dir = copyOfRepo()
    setVersion(dir, '9.8.7')
    expect(checkVersions(dir, 'v9.8.7').join('\n')).toMatch(/CHANGELOG\.md has no "## \[9\.8\.7\]/)
    edit(dir, 'CHANGELOG.md', (t) => t.replace('## [Unreleased]', '## [9.8.7]'))
    expect(checkVersions(dir, 'v9.8.7').join('\n')).toMatch(/CHANGELOG/)
  })

  it('fails on a malformed tag', () => {
    expect(checkVersions(releasable('9.8.7'), '9.8.7').join('\n')).toMatch(/must look like v1\.2\.3/)
  })
})
