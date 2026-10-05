// @vitest-environment happy-dom

import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { Menu } from './Menu'

afterEach(cleanup)

function setup() {
  const rename = vi.fn()
  const forget = vi.fn()
  render(
    <Menu
      label="Lens actions"
      items={[
        { label: 'Rename', onSelect: rename },
        { label: 'Forget Lens', icon: 'trash', danger: true, onSelect: forget },
      ]}
    />,
  )
  return { rename, forget, trigger: screen.getByRole('button', { name: 'Lens actions' }) }
}

describe('Menu', () => {
  it('opens a named menu from its button and focuses the first item', () => {
    const { trigger } = setup()
    expect(trigger.getAttribute('aria-haspopup')).toBe('menu')
    expect(trigger.getAttribute('aria-expanded')).toBe('false')
    fireEvent.click(trigger)
    expect(trigger.getAttribute('aria-expanded')).toBe('true')
    expect(screen.getByRole('menu', { name: 'Lens actions' })).toBeTruthy()
    expect(document.activeElement).toBe(screen.getByRole('menuitem', { name: 'Rename' }))
  })

  it('moves with the arrow keys, wrapping round', () => {
    const { trigger } = setup()
    fireEvent.click(trigger)
    const menu = screen.getByRole('menu')
    fireEvent.keyDown(menu, { key: 'ArrowDown' })
    expect(document.activeElement).toBe(screen.getByRole('menuitem', { name: 'Forget Lens' }))
    fireEvent.keyDown(menu, { key: 'ArrowDown' })
    expect(document.activeElement).toBe(screen.getByRole('menuitem', { name: 'Rename' }))
  })

  it('runs an item, closes, and gives focus back to the button', () => {
    const { trigger, forget } = setup()
    fireEvent.click(trigger)
    fireEvent.click(screen.getByRole('menuitem', { name: 'Forget Lens' }))
    expect(forget).toHaveBeenCalledOnce()
    expect(screen.queryByRole('menu')).toBeNull()
    expect(document.activeElement).toBe(trigger)
  })

  it('closes on Escape and on a click outside', () => {
    const { trigger } = setup()
    fireEvent.click(trigger)
    fireEvent.keyDown(screen.getByRole('menu'), { key: 'Escape' })
    expect(screen.queryByRole('menu')).toBeNull()
    expect(document.activeElement).toBe(trigger)

    fireEvent.click(trigger)
    fireEvent.pointerDown(document.body)
    expect(screen.queryByRole('menu')).toBeNull()
  })
})
