// @vitest-environment happy-dom

import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { useState } from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { Button } from './Button'
import { DIALOG_EXIT_MS, Dialog } from './Dialog'
import { Toaster } from './Toast'

afterEach(() => {
  cleanup()
  vi.useRealTimers()
})

function Page({ onClose = () => {}, dismissible }: { onClose?: () => void; dismissible?: boolean }) {
  const [open, setOpen] = useState(false)
  const close = () => {
    onClose()
    setOpen(false)
  }
  return (
    <>
      <Button onClick={() => setOpen(true)}>Forget Lens</Button>
      <Dialog
        open={open}
        onClose={close}
        dismissible={dismissible}
        title="Forget “Work”?"
        description="It moves to Archive for 7 days."
        footer={
          <>
            <Button variant="ghost" onClick={close}>
              Cancel
            </Button>
            <Button variant="danger">Forget</Button>
          </>
        }
      />
    </>
  )
}

const openIt = () => fireEvent.click(screen.getByRole('button', { name: 'Forget Lens' }))

describe('Dialog', () => {
  it('is a modal named by its title and described by its text', () => {
    render(<Page />)
    openIt()
    const dialog = screen.getByRole('dialog', { name: 'Forget “Work”?' })
    expect(dialog.getAttribute('aria-modal')).toBe('true')
    expect(document.getElementById(dialog.getAttribute('aria-describedby')!)!.textContent).toBe('It moves to Archive for 7 days.')
  })

  it('moves focus in, keeps Tab inside, and gives focus back on close', () => {
    render(<Page />)
    const opener = screen.getByRole('button', { name: 'Forget Lens' })
    opener.focus()
    openIt()
    const cancel = screen.getByRole('button', { name: 'Cancel' })
    const forget = screen.getByRole('button', { name: 'Forget' })
    expect(document.activeElement).toBe(cancel)

    forget.focus()
    fireEvent.keyDown(forget, { key: 'Tab' })
    expect(document.activeElement).toBe(cancel)
    fireEvent.keyDown(cancel, { key: 'Tab', shiftKey: true })
    expect(document.activeElement).toBe(forget)

    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }))
    expect(document.activeElement).toBe(opener)
  })

  it('makes the rest of the page unreachable while open, except toasts', () => {
    const { container } = render(
      <>
        <Page />
        <Toaster toast={null} />
      </>,
    )
    openIt()
    expect(container.getAttribute('aria-hidden')).toBe('true')
    expect(container.hasAttribute('inert')).toBe(true)
    expect(screen.queryByRole('button', { name: 'Forget Lens' })).toBeNull()
    expect(screen.getByRole('alert')).toBeTruthy()

    fireEvent.keyDown(screen.getByRole('dialog'), { key: 'Escape' })
    expect(container.getAttribute('aria-hidden')).toBeNull()
    expect(container.hasAttribute('inert')).toBe(false)
  })

  it('closes on Escape and on a click outside, but not while not dismissible', () => {
    const onClose = vi.fn()
    const { rerender } = render(<Page onClose={onClose} />)
    openIt()
    fireEvent.keyDown(screen.getByRole('dialog'), { key: 'Escape' })
    expect(onClose).toHaveBeenCalledTimes(1)

    rerender(<Page onClose={onClose} dismissible={false} />)
    openIt()
    fireEvent.keyDown(screen.getByRole('dialog'), { key: 'Escape' })
    fireEvent.mouseDown(screen.getByRole('dialog').parentElement!)
    expect(onClose).toHaveBeenCalledTimes(1)
  })

  it('is gone for assistive technology at once on close, and from the page after its exit', () => {
    vi.useFakeTimers()
    render(<Page />)
    openIt()
    fireEvent.keyDown(screen.getByRole('dialog'), { key: 'Escape' })
    expect(screen.queryByRole('dialog')).toBeNull()
    expect(document.querySelector('[role="dialog"]')).not.toBeNull()
    act(() => vi.advanceTimersByTime(DIALOG_EXIT_MS))
    expect(document.querySelector('[role="dialog"]')).toBeNull()
  })
})

describe('Toaster', () => {
  it('announces info politely and errors as alerts, in regions that are always there', () => {
    const { rerender } = render(<Toaster toast={null} />)
    const status = screen.getByRole('status')
    expect(status.getAttribute('aria-live')).toBe('polite')
    expect(screen.getByRole('alert').textContent).toBe('')

    rerender(<Toaster toast={{ id: 1, message: 'Router admin copied', detail: 'Clears in 30 s', countdown: 30 }} />)
    expect(screen.getByRole('status').textContent).toBe('Router admin copiedClears in 30 s')

    rerender(<Toaster toast={{ id: 2, message: "Couldn't save that change.", tone: 'error' }} />)
    expect(screen.getByRole('alert').textContent).toBe("Couldn't save that change.")
    expect(screen.getByRole('status').textContent).toBe('')
  })
})
