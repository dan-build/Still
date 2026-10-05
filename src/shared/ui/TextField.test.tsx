// @vitest-environment happy-dom

import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { useState } from 'react'
import { afterEach, describe, expect, it } from 'vitest'
import { SegmentedControl } from './SegmentedControl'
import { TextField } from './TextField'

afterEach(cleanup)

describe('TextField', () => {
  it('is named by its label and described by its hint', () => {
    render(<TextField label="Master password" hint="At least 8 characters." />)
    const input = screen.getByLabelText('Master password')
    const hint = document.getElementById(input.getAttribute('aria-describedby')!)!
    expect(hint.textContent).toBe('At least 8 characters.')
    expect(input.getAttribute('aria-invalid')).toBeNull()
  })

  it('shows an error in place of the hint, linked, announced and marked invalid', () => {
    render(<TextField label="Confirm password" hint="Type it again." error="The passwords don't match." />)
    const input = screen.getByLabelText('Confirm password')
    expect(input.getAttribute('aria-invalid')).toBe('true')
    const error = screen.getByRole('alert')
    expect(error.textContent).toBe("The passwords don't match.")
    expect(input.getAttribute('aria-describedby')).toBe(error.id)
    expect(screen.queryByText('Type it again.')).toBeNull()
  })

  it('keeps a hidden label for screen readers', () => {
    render(<TextField label="Master password" labelHidden placeholder="Master password" />)
    expect(screen.getByLabelText('Master password')).toBeTruthy()
    expect(screen.getByText('Master password', { selector: 'label' }).className).toContain('sr-only')
  })

  it('toggles a revealable value between hidden and shown', () => {
    render(<TextField label="Value" revealable defaultValue="hunter2" />)
    const input = screen.getByLabelText('Value') as HTMLInputElement
    expect(input.type).toBe('password')
    const toggle = screen.getByRole('button', { name: 'Show value', pressed: false })
    fireEvent.click(toggle)
    expect(input.type).toBe('text')
    expect(toggle.getAttribute('aria-pressed')).toBe('true')
  })

  it('can be a multi-line field', () => {
    render(<TextField label="Note" multiline rows={3} />)
    expect(screen.getByLabelText('Note').tagName).toBe('TEXTAREA')
  })

  it('masks a revealable multi-line value, keeping it a textarea', () => {
    render(<TextField label="Value" multiline revealable defaultValue={'line one\nline two'} />)
    const area = screen.getByLabelText('Value') as HTMLTextAreaElement
    expect(area.value).toBe('line one\nline two')
    expect(area.className).toContain('[-webkit-text-security:disc]')
    fireEvent.click(screen.getByRole('button', { name: 'Show value' }))
    expect(area.className).not.toContain('[-webkit-text-security:disc]')
  })
})

describe('SegmentedControl', () => {
  const TYPES = [
    { value: 'password', label: 'Password', icon: 'password' },
    { value: 'key', label: 'API key', icon: 'key' },
    { value: 'note', label: 'Note', icon: 'note' },
  ] as const

  function Picker() {
    const [type, setType] = useState<(typeof TYPES)[number]['value']>('password')
    return <SegmentedControl label="Type" options={TYPES} value={type} onChange={setType} />
  }

  it('is a named radio group with a single tab stop', () => {
    render(<Picker />)
    const group = screen.getByRole('radiogroup', { name: 'Type' })
    const radios = screen.getAllByRole('radio')
    expect(group).toBeTruthy()
    expect(radios.map((r) => r.getAttribute('tabindex'))).toEqual(['0', '-1', '-1'])
    expect(screen.getByRole('radio', { name: 'Password', checked: true })).toBeTruthy()
  })

  it('moves the choice and the focus with the arrow keys, wrapping round', () => {
    render(<Picker />)
    fireEvent.keyDown(screen.getByRole('radio', { name: 'Password' }), { key: 'ArrowRight' })
    expect(screen.getByRole('radio', { name: 'API key', checked: true })).toBe(document.activeElement)
    fireEvent.keyDown(document.activeElement!, { key: 'ArrowLeft' })
    fireEvent.keyDown(document.activeElement!, { key: 'ArrowLeft' })
    expect(screen.getByRole('radio', { name: 'Note', checked: true })).toBe(document.activeElement)
  })

  it('selects on click', () => {
    render(<Picker />)
    fireEvent.click(screen.getByRole('radio', { name: 'Note' }))
    expect(screen.getByRole('radio', { name: 'Note', checked: true })).toBeTruthy()
  })
})
