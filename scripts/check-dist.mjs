// Fails if the built app (dist/) contains code the release CSP would block,
// code that belongs in Rust, or CSS that macOS 12's webview can't read.
//
// - Scripts: no WebAssembly, libsodium, eval or new Function. The CSP is
//   script-src 'self', and the crypto must only ever run in Rust.
// - Stylesheets: no color-mix() outside an @supports block. macOS 12's
//   Safari 15 lacks color-mix; Lightning CSS (vite.config.ts) gives every
//   use a fallback, and this keeps it that way.
// Run after `vite build`.

import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const FORBIDDEN_IN_SCRIPTS = ['WebAssembly', 'libsodium', 'eval(', 'new Function(']

/** Every color-mix() in a stylesheet that isn't inside an @supports block, by surrounding text. */
export function unguardedColorMix(css) {
  const found = []
  const blocks = []
  let preamble = ''
  for (let i = 0; i < css.length; i++) {
    const c = css[i]
    if (c === '{') {
      blocks.push(preamble.trim())
      preamble = ''
    } else if (c === '}') {
      blocks.pop()
      preamble = ''
    } else {
      preamble += c
      // The @supports condition itself names color-mix; that's the guard, not a use.
      const inCondition = preamble.trimStart().startsWith('@supports')
      if (css.startsWith('color-mix(', i) && !inCondition && !blocks.some((b) => b.startsWith('@supports'))) {
        found.push(css.slice(Math.max(0, i - 60), i + 40).replace(/\s+/g, ' '))
      }
    }
  }
  return found
}

function files(dir) {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name)
    return statSync(path).isDirectory() ? files(path) : [path]
  })
}

export function problems(dir) {
  return files(dir).flatMap((path) => {
    if (path.endsWith('.wasm')) return [`${path}: a WebAssembly file`]
    if (path.endsWith('.css')) {
      return unguardedColorMix(readFileSync(path, 'utf8')).map((at) => `${path}: color-mix() without a fallback, near "${at}"`)
    }
    if (!/\.(js|mjs|html)$/.test(path)) return []
    const text = readFileSync(path, 'utf8')
    return FORBIDDEN_IN_SCRIPTS.filter((needle) => text.includes(needle)).map((needle) => `${path}: contains ${needle}`)
  })
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const found = problems('dist')
  if (found.length > 0) {
    console.error('dist/ contains code that must not ship:\n' + found.map((f) => `  ${f}`).join('\n'))
    process.exit(1)
  }
  console.log('dist/ is clean: no WebAssembly, libsodium, eval, new Function, or unguarded color-mix().')
}
