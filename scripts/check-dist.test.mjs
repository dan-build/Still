import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, sep } from 'node:path'
import { describe, expect, it } from 'vitest'
import { problems, unguardedColorMix } from './check-dist.mjs'

describe('check-dist', () => {
  it('accepts color-mix() behind @supports, with a fallback before it', () => {
    const css = '.a{color:#15151566}@supports (color:color-mix(in lab,red,red)){.a{color:color-mix(in oklab,#151515 40%,transparent)}}'
    expect(unguardedColorMix(css)).toEqual([])
  })

  it('finds color-mix() that Safari 15 would have no fallback for', () => {
    const css = '@layer utilities{.a{color:color-mix(in oklab,#151515 40%,transparent)}}'
    expect(unguardedColorMix(css)).toHaveLength(1)
  })

  it('reports forbidden script code and unguarded CSS in a build folder', () => {
    const dir = mkdtempSync(join(tmpdir(), 'still-dist-'))
    writeFileSync(join(dir, 'a.js'), 'const x = eval("1")')
    writeFileSync(join(dir, 'b.css'), '.a{color:color-mix(in oklab,red 10%,transparent)}')
    writeFileSync(join(dir, 'c.css'), "@font-face{font-family:x;src:url(data:font/woff2;base64,AAAA) format('woff2')}")
    writeFileSync(join(dir, 'd.css'), "@font-face{font-family:x;src:url(/assets/x.woff2) format('woff2')}")
    writeFileSync(join(dir, 'ok.js'), 'console.log(1)')
    // Paths use the platform's separator (\ on Windows).
    expect(problems(dir).map((p) => p.replace(dir + sep, ''))).toEqual([
      'a.js: contains eval(',
      expect.stringMatching(/^b\.css: color-mix\(\) without a fallback/),
      'c.css: a font inlined as a data: URL',
    ])
  })
})
