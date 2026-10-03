// Fails if the built app (dist/) contains code the release CSP would block
// or that belongs in Rust: WebAssembly, libsodium, eval or new Function.
// The CSP is script-src 'self', so any of these would break at runtime, and
// the crypto must only ever run in Rust. Run after `vite build`.

import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'

const FORBIDDEN = ['WebAssembly', 'libsodium', 'eval(', 'new Function(']

function files(dir) {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name)
    return statSync(path).isDirectory() ? files(path) : [path]
  })
}

const found = files('dist')
  .filter((path) => /\.(js|mjs|html|wasm)$/.test(path))
  .flatMap((path) => {
    if (path.endsWith('.wasm')) return [`${path}: a WebAssembly file`]
    const text = readFileSync(path, 'utf8')
    return FORBIDDEN.filter((needle) => text.includes(needle)).map((needle) => `${path}: contains ${needle}`)
  })

if (found.length > 0) {
  console.error('dist/ contains code that must not ship in the webview:\n' + found.map((f) => `  ${f}`).join('\n'))
  process.exit(1)
}
console.log('dist/ is clean: no WebAssembly, libsodium, eval or new Function.')
