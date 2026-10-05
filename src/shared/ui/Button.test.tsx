// @vitest-environment happy-dom

import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { Button, IconButton } from './Button'
import { Kbd } from './Kbd'

afterEach(cleanup)

describe('Button', () => {
  it('is a plain button named by its label, with a decorative icon', () => {
    const onClick = vi.fn()
    render(
      <Button variant="primary" icon="plus" onClick={onClick}>
        Add secret
      </Button>,
    )
    const button = screen.getByRole('button', { name: 'Add secret' })
    // type="button", so it never submits a surrounding form by accident.
    expect(button.getAttribute('type')).toBe('button')
    expect(button.querySelector('svg')!.getAttribute('aria-hidden')).toBe('true')
    fireEvent.click(button)
    expect(onClick).toHaveBeenCalledOnce()
  })

  it('does nothing while disabled', () => {
    const onClick = vi.fn()
    render(
      <Button disabled onClick={onClick}>
        Create vault
      </Button>,
    )
    fireEvent.click(screen.getByRole('button', { name: 'Create vault' }))
    expect(onClick).not.toHaveBeenCalled()
  })
})

describe('IconButton', () => {
  it('is named by its label, not by its icon', () => {
    render(<IconButton icon="copy" label="Copy Router admin" />)
    const button = screen.getByRole('button', { name: 'Copy Router admin' })
    expect(button.querySelector('svg')!.getAttribute('aria-hidden')).toBe('true')
  })

  it('reports a toggle state through aria-pressed', () => {
    render(<IconButton icon="eye" label="Reveal" aria-pressed={true} />)
    expect(screen.getByRole('button', { name: 'Reveal', pressed: true })).toBeTruthy()
  })
})

describe('Kbd', () => {
  it('is hidden from assistive technology', () => {
    const { container } = render(<Kbd>⌘L</Kbd>)
    expect(container.querySelector('kbd')!.getAttribute('aria-hidden')).toBe('true')
  })
})
