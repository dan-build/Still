// Keeps Still's version the same everywhere, and checks a release tag against it.
//
//   node scripts/version.mjs set 0.1.1     update every version source
//   node scripts/version.mjs check v0.1.1  fail unless all match the tag and CHANGELOG has [0.1.1]
//   node scripts/version.mjs check         fail unless all version sources agree
//
// Version sources: package.json, package-lock.json (top level and root package),
// Cargo.toml [workspace.package], Cargo.lock (the still package) and
// src-tauri/tauri.conf.json.

import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const SEMVER = /^\d+\.\d+\.\d+$/
const CARGO_WORKSPACE = /(\[workspace\.package\][^[]*?\nversion = ")([^"]+)(")/
const CARGO_LOCK = /(\[\[package\]\]\nname = "still"\nversion = ")([^"]+)(")/
const TAURI_CONF = /(\n {2}"version": ")([^"]+)(")/

const read = (root, file) => readFileSync(join(root, file), 'utf8')

function match(text, pattern, file) {
  const found = text.match(pattern)
  if (!found) throw new Error(`Could not find the version in ${file}`)
  return found[2]
}

/** Every version source and the version it holds. */
export function readVersions(root) {
  const pkg = JSON.parse(read(root, 'package.json'))
  const lock = JSON.parse(read(root, 'package-lock.json'))
  return {
    'package.json': pkg.version,
    'package-lock.json': lock.version,
    'package-lock.json (root package)': lock.packages?.['']?.version,
    'Cargo.toml [workspace.package]': match(read(root, 'Cargo.toml'), CARGO_WORKSPACE, 'Cargo.toml'),
    'Cargo.lock (still)': match(read(root, 'Cargo.lock'), CARGO_LOCK, 'Cargo.lock'),
    'src-tauri/tauri.conf.json': match(read(root, 'src-tauri/tauri.conf.json'), TAURI_CONF, 'src-tauri/tauri.conf.json'),
  }
}

export function setVersion(root, version) {
  if (!SEMVER.test(version)) throw new Error(`Not a version like 1.2.3: ${version}`)
  const writeJson = (file, update) => {
    const data = JSON.parse(read(root, file))
    update(data)
    writeFileSync(join(root, file), JSON.stringify(data, null, 2) + '\n')
  }
  const replace = (file, pattern) => {
    const text = read(root, file)
    match(text, pattern, file)
    writeFileSync(join(root, file), text.replace(pattern, `$1${version}$3`))
  }
  writeJson('package.json', (pkg) => (pkg.version = version))
  writeJson('package-lock.json', (lock) => {
    lock.version = version
    lock.packages[''].version = version
  })
  replace('Cargo.toml', CARGO_WORKSPACE)
  replace('Cargo.lock', CARGO_LOCK)
  replace('src-tauri/tauri.conf.json', TAURI_CONF)
}

/** Problems that should stop a release; empty when everything is consistent. */
export function checkVersions(root, tag) {
  const versions = readVersions(root)
  const problems = []
  const distinct = [...new Set(Object.values(versions))]
  if (distinct.length !== 1) {
    problems.push(`Version sources disagree: ${Object.entries(versions).map(([file, v]) => `${file}=${v}`).join(', ')}`)
  }
  if (tag !== undefined) {
    const version = tag.replace(/^v/, '')
    if (!/^v\d+\.\d+\.\d+$/.test(tag)) problems.push(`Tag must look like v1.2.3: ${tag}`)
    for (const [file, v] of Object.entries(versions)) {
      if (v !== version) problems.push(`${file} is ${v}, but the tag is ${tag}`)
    }
    const heading = new RegExp(`^## \\[${version.replace(/\./g, '\\.')}\\] - \\d{4}-\\d{2}-\\d{2}$`, 'm')
    if (!heading.test(read(root, 'CHANGELOG.md'))) problems.push(`CHANGELOG.md has no "## [${version}] - YYYY-MM-DD" section`)
  }
  return problems
}

// ---- command line ------------------------------------------------------------

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const root = join(fileURLToPath(import.meta.url), '..', '..')
  const [command, arg] = process.argv.slice(2)
  if (command === 'set' && arg) {
    setVersion(root, arg)
    console.log(`Version set to ${arg}`)
  } else if (command === 'check') {
    const problems = checkVersions(root, arg)
    if (problems.length > 0) {
      for (const problem of problems) console.error(`✗ ${problem}`)
      process.exit(1)
    }
    console.log(arg ? `Ready to release ${arg}` : `All version sources agree: ${Object.values(readVersions(root))[0]}`)
  } else {
    console.error('usage: node scripts/version.mjs set 1.2.3 | check [v1.2.3]')
    process.exit(2)
  }
}
