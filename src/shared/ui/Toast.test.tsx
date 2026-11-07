// @vitest-environment happy-dom

import { cleanup, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'
import { Toaster } from './Toast'

afterEach(cleanup)

const LONG = "Couldn't upgrade your vault to the new format. It's unchanged, and Still will try again the next time it starts."

/** The toast's box: the element holding the icon and the message. */
const box = (text: string) => screen.getByText(text).parentElement!

describe('Toaster', () => {
  // A toast was one fixed-height line that hid overflow, so a long message
  // was cut off mid-sentence.
  it.fails('lets a long message wrap within a maximum width instead of cutting it off', () => {
    render(<Toaster toast={{ id: 1, message: LONG, tone: 'error' }} />)
    const classes = box(LONG).className.split(/\s+/)
    expect(classes).not.toContain('whitespace-nowrap')
    expect(classes).not.toContain('h-9')
    expect(classes.some((c) => c.startsWith('max-w-'))).toBe(true)
  })

  it('shows a long message in full, announced as an alert', () => {
    render(<Toaster toast={{ id: 1, message: LONG, tone: 'error' }} />)
    expect(screen.getByRole('alert').textContent).toContain(LONG)
  })
})
