// Every text and icon pair the design uses meets WCAG AA, in both themes.
// The colours are read from globals.css itself, so changing a token re-runs
// the check. Text needs 4.5:1; icons and input borders need 3:1 (WCAG 1.4.11).

import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

const css = readFileSync(new URL('./globals.css', import.meta.url), 'utf8')

/** The custom properties in the first block that starts at `marker`. */
function tokens(marker: string): Record<string, string> {
  const start = css.indexOf(marker)
  if (start < 0) throw new Error(`globals.css has no ${marker}`)
  const open = css.indexOf('{', css.indexOf(':root', start))
  const body = css.slice(open + 1, css.indexOf('}', open))
  return Object.fromEntries([...body.matchAll(/--([\w-]+):\s*(#[0-9a-f]{6})\s*;/gi)].map(([, name, value]) => [name, value.toLowerCase()]))
}

const light = tokens('/*\n  Design tokens')
const dark = { ...light, ...tokens('@media (prefers-color-scheme: dark)') }

function luminance(hex: string) {
  const [r, g, b] = [1, 3, 5].map((i) => {
    const c = parseInt(hex.slice(i, i + 2), 16) / 255
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4
  })
  return 0.2126 * r + 0.7152 * g + 0.0722 * b
}

function ratio(a: string, b: string) {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x)
  return (hi + 0.05) / (lo + 0.05)
}

// [foreground, background, minimum, what uses it]
const PAIRS: [string, string, number, string][] = [
  ['g1', 'bg', 4.5, 'primary text'],
  ['g1', 'sidebar', 4.5, 'sidebar text'],
  ['g1', 'raised', 4.5, 'dialog text'],
  ['g1', 'selected', 4.5, 'the selected Lens'],
  ['g2', 'bg', 4.5, 'revealed values'],
  ['g3', 'bg', 4.5, 'secondary text'],
  ['g3', 'sidebar', 4.5, 'sidebar items'],
  ['g3', 'raised', 4.5, 'dialog text'],
  ['g4', 'bg', 4.5, 'counts and hints'],
  ['g4', 'sidebar', 4.5, 'sidebar counts'],
  ['g4', 'raised', 4.5, 'dialog hints'],
  ['g4', 'field', 4.5, 'placeholders'],
  ['g4', 'hover', 4.5, 'text on a hovered row'],
  ['g4', 'selected', 4.5, 'the selected Lens count'],
  ['g5', 'bg', 3, 'icons at rest'],
  ['g5', 'sidebar', 3, 'sidebar icons'],
  ['g6', 'field', 3, 'input borders'],
  ['g6', 'raised', 3, 'input borders in dialogs'],
  ['on-accent', 'accent-fill', 4.5, 'primary button labels'],
  ['on-accent', 'accent-fill-hover', 4.5, 'hovered primary buttons'],
  ['accent-text', 'bg', 4.5, 'accent text'],
  ['accent-text', 'raised', 4.5, 'accent text in dialogs'],
  ['accent', 'bg', 3, 'focus rings and the copied check'],
  ['accent', 'sidebar', 3, 'the selected Lens icon'],
  ['danger', 'bg', 4.5, 'error text'],
  ['danger', 'raised', 4.5, 'error text in dialogs'],
  ['on-danger', 'danger', 4.5, 'danger button labels'],
  ['on-danger', 'danger-hover', 4.5, 'hovered danger buttons'],
  ['warning', 'bg', 4.5, 'warning text'],
  ['warning', 'sidebar', 3, 'the notice icon'],
  ['success', 'raised', 3, 'success icons'],
]

it('reads both themes from globals.css', () => {
  expect(Object.keys(light).length).toBeGreaterThan(20)
  expect(light.bg).toBe('#ffffff')
  expect(dark.bg).not.toBe(light.bg)
  expect(dark['accent-fill']).not.toBe(light['accent-fill'])
})

describe.each([
  ['light', light],
  ['dark', dark],
])('contrast in the %s theme', (_theme, colours) => {
  it.each(PAIRS)('%s on %s is at least %s:1 (%s)', (fg, bg, minimum) => {
    expect(colours[fg], `--${fg}`).toMatch(/^#/)
    expect(colours[bg], `--${bg}`).toMatch(/^#/)
    expect(ratio(colours[fg], colours[bg])).toBeGreaterThanOrEqual(minimum)
  })
})
