// @vitest-environment happy-dom

import { cleanup, render } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'
import { ICON_NAMES, Icon, Mark } from './Icon'

afterEach(cleanup)

describe('Icon', () => {
  it('has exactly the approved set', () => {
    expect([...ICON_NAMES].sort()).toEqual(
      [
        'archive', 'arrow-right', 'back', 'check', 'close', 'copy', 'eye', 'eye-off', 'key', 'lens',
        'lock', 'more', 'note', 'password', 'plus', 'restore', 'trash', 'unlock', 'warning',
      ].sort(),
    )
  })

  it.each(ICON_NAMES)('%s is drawn at 16px with a 1.5px round stroke in currentColor', (name) => {
    const svg = render(<Icon name={name} />).container.querySelector('svg')!
    expect(svg.getAttribute('width')).toBe('16')
    expect(svg.getAttribute('height')).toBe('16')
    expect(svg.getAttribute('viewBox')).toBe('0 0 16 16')
    expect(svg.getAttribute('stroke')).toBe('currentColor')
    expect(svg.getAttribute('stroke-width')).toBe('1.5')
    expect(svg.getAttribute('stroke-linecap')).toBe('round')
    expect(svg.getAttribute('stroke-linejoin')).toBe('round')
    expect(svg.getAttribute('fill')).toBe('none')
    expect(svg.children.length).toBeGreaterThan(0)
  })

  it('is hidden from assistive technology unless it has a label', () => {
    const hidden = render(<Icon name="lock" />).container.querySelector('svg')!
    expect(hidden.getAttribute('aria-hidden')).toBe('true')
    expect(hidden.getAttribute('role')).toBeNull()

    const labelled = render(<Icon name="key" label="API key" />).container.querySelector('svg')!
    expect(labelled.getAttribute('role')).toBe('img')
    expect(labelled.getAttribute('aria-label')).toBe('API key')
    expect(labelled.getAttribute('aria-hidden')).toBeNull()
  })

  it('gives each eye-off its own mask, so two on a page never share one', () => {
    const { container } = render(
      <>
        <Icon name="eye-off" />
        <Icon name="eye-off" />
      </>,
    )
    const ids = [...container.querySelectorAll('mask')].map((m) => m.id)
    expect(ids).toHaveLength(2)
    expect(new Set(ids).size).toBe(2)
    for (const id of ids) expect(container.querySelector(`[mask="url(#${id})"]`)).not.toBeNull()
  })
})

describe('Mark', () => {
  it('keeps the same on-screen stroke at any size', () => {
    const small = render(<Mark size={16} stroke={1.5} />).container.querySelector('svg')!
    const large = render(<Mark size={48} stroke={2} />).container.querySelector('svg')!
    expect(small.getAttribute('stroke-width')).toBe('1.5')
    // 2px on screen at 48px is 2 × 16 / 48 in the 16-unit viewBox.
    expect(Number(large.getAttribute('stroke-width'))).toBeCloseTo((2 * 16) / 48)
    expect(large.getAttribute('aria-hidden')).toBe('true')
  })
})
