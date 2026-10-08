// @vitest-environment happy-dom
//
// The lock screens on their own. App.test.tsx drives them inside the app;
// these check the screens' own behaviour.

import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import CreatePasswordScreen from './CreatePasswordScreen'
import UnlockScreen from './UnlockScreen'

afterEach(cleanup)

const type = (label: string, value: string) => fireEvent.change(screen.getByLabelText(label), { target: { value } })

describe('UnlockScreen', () => {
  it('fills the Unlock arrow only once there is something to submit', () => {
    render(<UnlockScreen onUnlock={vi.fn()} />)
    const unlock = screen.getByRole('button', { name: 'Unlock' }) as HTMLButtonElement
    expect(unlock.disabled).toBe(true)
    type('Master password', ' ')
    expect(unlock.disabled).toBe(false)
  })

  it('submits on Return, and on a wrong password clears the field and links the error to it', async () => {
    const onUnlock = vi.fn().mockResolvedValue('wrong-password')
    render(<UnlockScreen onUnlock={onUnlock} />)
    type('Master password', 'nope')
    fireEvent.submit(screen.getByLabelText('Master password'))

    const error = await screen.findByRole('alert')
    expect(onUnlock).toHaveBeenCalledWith('nope')
    expect(error.textContent).toBe('Incorrect password. Try again.')
    const field = screen.getByLabelText('Master password') as HTMLInputElement
    expect(field.value).toBe('')
    expect(field.getAttribute('aria-invalid')).toBe('true')
    expect(field.getAttribute('aria-describedby')).toBe(error.id)
    // The field is empty again, so there's nothing to submit.
    expect((screen.getByRole('button', { name: 'Unlock' }) as HTMLButtonElement).disabled).toBe(true)
  })

  it('says it is unlocking, and treats a thrown error as a failure', async () => {
    let finish!: (outcome: never) => void
    const onUnlock = vi.fn(() => new Promise<never>((_, reject) => (finish = reject)))
    render(<UnlockScreen onUnlock={onUnlock} />)
    type('Master password', 'pw')
    fireEvent.submit(screen.getByLabelText('Master password'))

    await screen.findByText('Unlocking…')
    expect((screen.getByLabelText('Master password') as HTMLInputElement).disabled).toBe(true)
    finish(new Error('boom') as never)
    expect((await screen.findByRole('alert')).textContent).toContain('Unlocking failed. Nothing was changed.')
  })
})

describe('CreatePasswordScreen', () => {
  it('keeps Create vault disabled until the passwords are long enough and match', () => {
    render(<CreatePasswordScreen onCreate={vi.fn()} />)
    const create = screen.getByRole('button', { name: 'Create vault' }) as HTMLButtonElement
    type('Master password', 'short')
    type('Confirm password', 'short')
    expect(create.disabled).toBe(true)
    type('Master password', 'long-enough')
    type('Confirm password', 'long-enough')
    expect(create.disabled).toBe(false)
  })

  it("says the passwords don't match only once that's certain", () => {
    render(<CreatePasswordScreen onCreate={vi.fn()} />)
    type('Master password', 'long-enough')
    type('Confirm password', 'long')
    expect(screen.queryByText("The passwords don't match.")).toBeNull()
    type('Confirm password', 'long-enougX')
    expect(screen.getByText("The passwords don't match.")).toBeTruthy()

    // Leaving the field early also makes it certain.
    type('Confirm password', 'lo')
    fireEvent.blur(screen.getByLabelText('Confirm password'))
    expect(screen.getByText("The passwords don't match.")).toBeTruthy()
  })

  it('creates the vault on Return', async () => {
    const onCreate = vi.fn().mockResolvedValue(undefined)
    render(<CreatePasswordScreen onCreate={onCreate} />)
    type('Master password', 'long-enough')
    type('Confirm password', 'long-enough')
    fireEvent.submit(screen.getByLabelText('Confirm password'))
    await waitFor(() => expect(onCreate).toHaveBeenCalledWith('long-enough'))
  })
})
