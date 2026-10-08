// @vitest-environment happy-dom
//
// UI tests for src/app/App.tsx: they drive the real UI against src/test/fakeVaultApi.ts,
// an in-memory stand-in for the vault commands, and check what the UI asks of
// them and shows. How the vault is stored is Rust's job, tested in
// crates/still-core against the golden vaults and fixtures/vault-behaviour-v1.
//
// `it.fails` marks a known bug. The test body says what should happen; it
// fails today. When a fix lands, change `it.fails` to `it` in the same commit.
// Each `it.fails` has a passing sibling that runs the same steps, so a broken
// step can't make a known-bug test "pass" by accident.

import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { createElement } from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { FakeVault, fakeLens, type FakeLens } from '@/test/fakeVaultApi'

// The vault commands, answered by whichever FakeVault the test set up.
const current = vi.hoisted(() => ({ vault: undefined as unknown }))
vi.mock('@/platform/tauri/vaultApi', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/platform/tauri/vaultApi')>()),
  createTauriVaultApi: () => current.vault,
}))
// Rust's auto-lock: the test can fire the vault-locked event and count activity reports.
const autoLock = vi.hoisted(() => ({ fire: undefined as undefined | ((reason: 'idle' | 'sleep') => void), activity: 0 }))
vi.mock('@/platform/tauri/session', () => ({
  reportActivity: () => { autoLock.activity += 1 },
  onAutoLocked: (onLocked: (reason: 'idle' | 'sleep') => void) => {
    autoLock.fire = onLocked
    return () => { if (autoLock.fire === onLocked) autoLock.fire = undefined }
  },
}))

import StillHome from './App'

// ---- set-up -------------------------------------------------------------------

const PASSWORD = 'test-password-1'
const DAY = 24 * 60 * 60 * 1000

/** A stored vault (locked), with the given Lenses, made current for the app. */
function seedVault({ lenses = [], bin = [], password = PASSWORD }: { lenses?: FakeLens[]; bin?: FakeLens[]; password?: string } = {}) {
  const vault = new FakeVault({ password, lenses, bin })
  current.vault = vault
  return vault
}

/** No vault stored. */
function freshInstall() {
  const vault = new FakeVault()
  current.vault = vault
  return vault
}

const lens = (vault: FakeVault, name: string) => [...vault.lenses, ...vault.bin].find((l) => l.name === name)!
const lensNames = (list: FakeLens[]) => list.map((l) => l.name)

// ---- UI steps -----------------------------------------------------------------

async function enterPassword(password = PASSWORD) {
  fireEvent.change(await screen.findByPlaceholderText('Master password'), { target: { value: password } })
  fireEvent.click(screen.getByRole('button', { name: 'Unlock' }))
}

async function unlock(password = PASSWORD) {
  render(createElement(StillHome))
  await enterPassword(password)
  await screen.findByRole('button', { name: /^Archive/ })
}

async function openLens(name: string) {
  fireEvent.click(await screen.findByRole('button', { name: new RegExp(`^${name},`) }))
  await screen.findByRole('heading', { name, level: 1 })
}

async function forgetOpenLens() {
  fireEvent.click(screen.getByRole('button', { name: 'Lens actions' }))
  fireEvent.click(screen.getByRole('menuitem', { name: 'Forget Lens' }))
  fireEvent.click(await screen.findByRole('button', { name: 'Forget Lens' }))
}

async function openArchive() {
  fireEvent.click(screen.getByRole('button', { name: /^Archive/ }))
  await screen.findByRole('heading', { name: 'Archive', level: 1 })
}

async function createLens(name: string) {
  fireEvent.click(screen.getByRole('button', { name: 'New Lens' }))
  fireEvent.change(await screen.findByPlaceholderText('e.g. Banking Keys'), { target: { value: name } })
  fireEvent.click(screen.getByRole('button', { name: 'Create Lens' }))
}

// The Lens header's Add secret (an empty Lens shows a second one).
const openAddSecret = () => fireEvent.click(screen.getAllByRole('button', { name: 'Add secret' })[0])

async function addSecret(label: string, value: string) {
  openAddSecret()
  fireEvent.change(await screen.findByPlaceholderText('What is this for?'), { target: { value: label } })
  fireEvent.change(screen.getByPlaceholderText('Paste or type the secret here…'), { target: { value } })
  fireEvent.click(screen.getByRole('button', { name: 'Add secret' }))
}

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
})

// ---- tests ----------------------------------------------------------------------

describe('unlock', () => {
  it('shows every Lens once unlocked', async () => {
    seedVault({ lenses: [fakeLens('l1', 'Alpha'), fakeLens('l2', 'Beta')] })
    await unlock()
    await screen.findAllByText('Alpha')
    await screen.findAllByText('Beta')
  })

  it('shows an error and stays locked on a wrong password', async () => {
    seedVault({ lenses: [fakeLens('l1', 'Alpha')] })
    render(createElement(StillHome))
    await enterPassword('not-the-password')

    await screen.findByText('Incorrect password. Try again.')
    expect(screen.queryByRole('button', { name: /^Archive/ })).toBeNull()
  })

  it('unlocks a vault whose password is only spaces (B7)', async () => {
    seedVault({ lenses: [fakeLens('l1', 'Alpha')], password: '        ' })
    await unlock('        ')
  })

  it('reports unreadable vault data differently from a wrong password (S4)', async () => {
    seedVault({ lenses: [fakeLens('l1', 'Alpha')] }).unreadableData = true
    render(createElement(StillHome))
    await enterPassword()

    await screen.findByText(/couldn.t read this vault/i)
  })
})

describe('after the vault moved into its file', () => {
  it('says so on the unlock screen, and keeps saying it until dismissed', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true })
    try {
      seedVault({ lenses: [fakeLens('l1', 'Alpha')] })
      render(createElement(StillHome, { notice: 'moved' }))
      await screen.findByPlaceholderText('Master password')
      const notice = () => screen.queryByText(/Your vault now lives in its own file\./)
      expect(notice()).not.toBeNull()
      act(() => vi.advanceTimersByTime(60_000))
      expect(notice()).not.toBeNull()

      fireEvent.click(screen.getByRole('button', { name: 'OK' }))
      expect(notice()).toBeNull()
    } finally {
      vi.useRealTimers()
    }
  })
})

describe('auto-lock', () => {
  for (const [reason, message] of [
    ['idle', 'Locked after 5 minutes without activity.'],
    ['sleep', 'Locked while your computer was asleep.'],
  ] as const) {
    it(`returns to the unlock screen and says why when Rust locks (${reason})`, async () => {
      seedVault({ lenses: [fakeLens('l1', 'Alpha')] })
      await unlock()
      await openLens('Alpha')
      act(() => autoLock.fire!(reason))

      await screen.findByPlaceholderText('Master password')
      expect(screen.getByRole('status').textContent).toContain(message)
      expect(screen.queryByText('Alpha')).toBeNull()
    })
  }

  it('reports activity at most every 15 seconds, and only while unlocked', async () => {
    seedVault({ lenses: [fakeLens('l1', 'Alpha')] })
    render(createElement(StillHome))
    await screen.findByPlaceholderText('Master password')
    autoLock.activity = 0
    fireEvent.keyDown(window, { key: 'a' })
    expect(autoLock.activity).toBe(0)
    expect(autoLock.fire).toBeUndefined()
    cleanup()

    await unlock()
    // The listeners attach in an effect after the unlocked screen renders,
    // together with the auto-lock subscription; wait for it, or a slow
    // machine sends the keys before anyone listens.
    await waitFor(() => expect(autoLock.fire).toBeDefined())
    autoLock.activity = 0
    fireEvent.keyDown(window, { key: 'a' })
    fireEvent.pointerDown(window)
    fireEvent.keyDown(window, { key: 'b' })
    expect(autoLock.activity).toBe(1)
  })
})

describe('lock', () => {
  it('has Rust forget any keys as soon as the app starts, before asking what to show', async () => {
    const vault = seedVault({ lenses: [fakeLens('l1', 'Alpha')] })
    vault.unlocked = true
    render(createElement(StillHome))
    await screen.findByPlaceholderText('Master password')
    expect(vault.calls.slice(0, 2)).toEqual(['lock', 'state'])
    expect(vault.unlocked).toBe(false)
  })

  it('returns to the unlock screen', async () => {
    const vault = seedVault({ lenses: [fakeLens('l1', 'Alpha')] })
    await unlock()
    fireEvent.click(screen.getByRole('button', { name: 'Lock' }))

    await screen.findByPlaceholderText('Master password')
    expect(screen.queryByRole('button', { name: /^Archive/ })).toBeNull()
    expect(vault.unlocked).toBe(false)
  })

  it('closes the open Lens, so it is not shown again after unlocking (S1)', async () => {
    seedVault({ lenses: [fakeLens('l1', 'Alpha')] })
    await unlock()
    await openLens('Alpha')
    fireEvent.click(screen.getByRole('button', { name: 'Lock' }))
    await enterPassword()
    await screen.findByRole('button', { name: /^Archive/ })

    expect(screen.queryByRole('button', { name: 'Forget Lens' })).toBeNull()
  })
})

describe('secrets', () => {
  it('adds a secret', async () => {
    const vault = seedVault({ lenses: [fakeLens('l1', 'Alpha')] })
    await unlock()
    await openLens('Alpha')
    await addSecret('GitHub', 'ghp-123')

    await screen.findByText('GitHub')
    expect(lens(vault, 'Alpha').items.find((i) => i.label === 'GitHub')).toMatchObject({ type: 'password', value: 'ghp-123' })
    expect(screen.queryByText('ghp-123')).toBeNull()
  })

  it('sends a secret exactly as typed, including edge spaces and line breaks (B3)', async () => {
    const vault = seedVault({ lenses: [fakeLens('l1', 'Alpha')] })
    await unlock()
    await openLens('Alpha')
    await addSecret('Spaced', '  spaced out \n')

    await waitFor(() => expect(lens(vault, 'Alpha').items.find((i) => i.label === 'Spaced')?.value).toBe('  spaced out \n'))
  })

  it('points out edge spaces and removes them on request', async () => {
    const vault = seedVault({ lenses: [fakeLens('l1', 'Alpha')] })
    await unlock()
    await openLens('Alpha')
    openAddSecret()
    fireEvent.change(await screen.findByPlaceholderText('What is this for?'), { target: { value: 'Token' } })
    const value = screen.getByPlaceholderText('Paste or type the secret here…') as HTMLTextAreaElement
    fireEvent.change(value, { target: { value: 'tok-123\n' } })

    await screen.findByText('This secret starts or ends with a space or line break. It will be kept exactly as typed.')
    fireEvent.click(screen.getByRole('button', { name: 'Remove them' }))
    expect(value.value).toBe('tok-123')
    expect(screen.queryByRole('button', { name: 'Remove them' })).toBeNull()

    fireEvent.click(screen.getByRole('button', { name: 'Add secret' }))
    await waitFor(() => expect(lens(vault, 'Alpha').items.find((i) => i.label === 'Token')?.value).toBe('tok-123'))
  })

  it('refuses a secret that is only spaces or line breaks, and says why', async () => {
    seedVault({ lenses: [fakeLens('l1', 'Alpha')] })
    await unlock()
    await openLens('Alpha')
    openAddSecret()
    fireEvent.change(await screen.findByPlaceholderText('What is this for?'), { target: { value: 'Blank' } })
    fireEvent.change(screen.getByPlaceholderText('Paste or type the secret here…'), { target: { value: '  \n ' } })

    await screen.findByText("A secret can't be only spaces or line breaks.")
    expect((screen.getByRole('button', { name: 'Add secret' }) as HTMLButtonElement).disabled).toBe(true)
  })

  it('turns off spellcheck and autocorrect for the secret value', async () => {
    seedVault({ lenses: [fakeLens('l1', 'Alpha')] })
    await unlock()
    await openLens('Alpha')
    openAddSecret()
    const value = await screen.findByPlaceholderText('Paste or type the secret here…')

    expect(value.getAttribute('spellcheck')).toBe('false')
    expect(value.getAttribute('autocorrect')).toBe('off')
    expect(value.getAttribute('autocomplete')).toBe('off')
  })

  it('copies a secret without revealing it in the page', async () => {
    const vault = seedVault({ lenses: [fakeLens('l1', 'Alpha')] })
    const writeText = vi.fn()
    Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true })
    await unlock()
    await openLens('Alpha')
    fireEvent.click(screen.getByRole('button', { name: 'Copy Alpha secret' }))

    await screen.findByText('Alpha secret copied')
    expect(vault.clipboard).toEqual(['value-of-l1'])
    expect(vault.calls).not.toContain('revealItem')
    expect(writeText).not.toHaveBeenCalled()
    expect(screen.queryByText('value-of-l1')).toBeNull()
  })

  it('reveals a saved secret', async () => {
    seedVault({ lenses: [fakeLens('l1', 'Alpha')] })
    await unlock()
    await openLens('Alpha')
    fireEvent.click(screen.getByRole('button', { name: 'Reveal Alpha secret' }))

    await screen.findByText('value-of-l1')
  })

  it('shows a revealed secret with its spaces and line breaks intact', async () => {
    seedVault({ lenses: [fakeLens('l1', 'Alpha')] })
    await unlock()
    await openLens('Alpha')
    await addSecret('Spaced', '  two-spaces-in-front\nsecond line')
    const reveal = (await screen.findByRole('button', { name: 'Reveal Spaced' })) as HTMLButtonElement
    await waitFor(() => expect(reveal.disabled).toBe(false))
    fireEvent.click(reveal)

    await waitFor(() =>
      expect(screen.getAllByTestId('secret-value').map((el) => el.textContent)).toContain('  two-spaces-in-front\nsecond line'),
    )
    const shown = screen.getAllByTestId('secret-value').find((el) => el.textContent?.startsWith('  two'))!
    // Without pre-wrap, the browser would collapse the leading spaces and the line break.
    expect(shown.className).toContain('whitespace-pre-wrap')
  })

  it('edits a secret\'s label and type, sending no value so the stored one stays', async () => {
    const vault = seedVault({ lenses: [fakeLens('l1', 'Alpha')] })
    const update = vi.spyOn(vault, 'updateItem')
    await unlock()
    await openLens('Alpha')
    fireEvent.click(screen.getByRole('button', { name: 'Edit Alpha secret' }))

    const label = (await screen.findByLabelText('Label')) as HTMLInputElement
    expect(label.value).toBe('Alpha secret')
    expect((screen.getByLabelText('New value') as HTMLTextAreaElement).value).toBe('')
    fireEvent.change(label, { target: { value: 'Renamed' } })
    fireEvent.click(screen.getByRole('radio', { name: 'API key' }))
    fireEvent.click(screen.getByRole('button', { name: 'Save' }))

    await screen.findByText('Renamed')
    expect(update).toHaveBeenCalledWith('l1', 'l1-item', { label: 'Renamed', type: 'key' })
    expect(lens(vault, 'Alpha').items[0]).toMatchObject({ id: 'l1-item', label: 'Renamed', type: 'key', value: 'value-of-l1' })
  })

  it('replaces a secret\'s value when a new one is typed', async () => {
    const vault = seedVault({ lenses: [fakeLens('l1', 'Alpha')] })
    await unlock()
    await openLens('Alpha')
    fireEvent.click(screen.getByRole('button', { name: 'Edit Alpha secret' }))
    fireEvent.change(await screen.findByLabelText('New value'), { target: { value: '  new value\n' } })
    fireEvent.click(screen.getByRole('button', { name: 'Save' }))

    await waitFor(() => expect(lens(vault, 'Alpha').items[0].value).toBe('  new value\n'))
    expect(lens(vault, 'Alpha').items.map((i) => i.id)).toEqual(['l1-item'])
  })

  it('renames a Lens from its menu', async () => {
    const vault = seedVault({ lenses: [fakeLens('l1', 'Alpha')] })
    await unlock()
    await openLens('Alpha')
    fireEvent.click(screen.getByRole('button', { name: 'Lens actions' }))
    fireEvent.click(screen.getByRole('menuitem', { name: 'Rename Lens' }))
    const name = (await screen.findByLabelText('Name')) as HTMLInputElement
    expect(name.value).toBe('Alpha')
    fireEvent.change(name, { target: { value: '  Banking  ' } })
    fireEvent.click(screen.getByRole('button', { name: 'Save' }))

    await screen.findByRole('heading', { name: 'Banking', level: 1 })
    expect(lensNames(vault.lenses)).toEqual(['Banking'])
  })

  it('deletes a secret, after asking', async () => {
    const vault = seedVault({ lenses: [fakeLens('l1', 'Alpha')] })
    await unlock()
    await openLens('Alpha')
    fireEvent.click(screen.getByRole('button', { name: 'Delete Alpha secret' }))
    // Deleting can't be undone, so it asks first.
    expect(vault.calls).not.toContain('deleteItem')
    fireEvent.click(await screen.findByRole('button', { name: 'Delete secret' }))

    await waitFor(() => expect(lens(vault, 'Alpha').items).toEqual([]))
    expect(screen.queryByText('Alpha secret')).toBeNull()
  })
})

describe('search', () => {
  it('finds secrets across Lenses by label, and works from the results', async () => {
    seedVault({ lenses: [fakeLens('l1', 'Alpha'), fakeLens('l2', 'Beta')] })
    await unlock()
    fireEvent.change(screen.getByLabelText('Search secrets'), { target: { value: 'beta SEC' } })

    await screen.findByRole('heading', { name: 'Search', level: 1 })
    expect(screen.getByText('1 secret in 1 Lens')).toBeTruthy()
    expect(screen.queryByRole('button', { name: 'Reveal Alpha secret' })).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: 'Reveal Beta secret' }))
    await screen.findByText('value-of-l2')
  })

  it('says what it searches when nothing matches, and Escape clears it', async () => {
    seedVault({ lenses: [fakeLens('l1', 'Alpha')] })
    await unlock()
    const field = screen.getByLabelText('Search secrets')
    fireEvent.change(field, { target: { value: 'value-of' } })
    // Values are never searched, even the right one.
    await screen.findByText('Nothing matches “value-of”')
    expect(screen.getByText(/Values stay encrypted, so they aren’t searched\./)).toBeTruthy()

    fireEvent.keyDown(field, { key: 'Escape' })
    await screen.findByRole('heading', { name: 'Alpha', level: 1 })
  })

  it('moves to the search field on ⌘F', async () => {
    seedVault({ lenses: [fakeLens('l1', 'Alpha')] })
    await unlock()
    fireEvent.keyDown(window, { key: 'f', metaKey: true })
    expect(document.activeElement).toBe(screen.getByLabelText('Search secrets'))
  })
})

describe('failed saves (B5)', () => {
  it('shows an error when a secret can\'t be saved, and shows nothing new', async () => {
    const vault = seedVault({ lenses: [fakeLens('l1', 'Alpha')] })
    await unlock()
    await openLens('Alpha')
    vault.failChanges = true
    await addSecret('Unsaved', 'v')

    await waitFor(() => expect(screen.getByRole('alert').textContent).toContain("Couldn't save the secret. Nothing was changed."))
    expect(screen.queryByText('Unsaved')).toBeNull()

    vault.failChanges = false
    fireEvent.click(await screen.findByRole('button', { name: 'Add secret' }))
    await screen.findByText('Unsaved')
  })

  it('keeps a Lens where it was when forgetting it can\'t be saved', async () => {
    const vault = seedVault({ lenses: [fakeLens('l1', 'Keep'), fakeLens('l2', 'Drop')] })
    await unlock()
    await openLens('Drop')
    vault.failChanges = true
    await forgetOpenLens()

    await waitFor(() => expect(screen.getByRole('alert').textContent).toContain("Couldn't save that change. Nothing was changed."))
    expect(screen.getAllByText('Drop').length).toBeGreaterThan(0)
    expect(screen.getByRole('button', { name: /^Archive/ }).textContent).not.toMatch(/1/)
  })
})

describe('forgetting a Lens', () => {
  it('moves it to the Archive', async () => {
    const vault = seedVault({ lenses: [fakeLens('l1', 'Keep'), fakeLens('l2', 'Drop')] })
    await unlock()
    await openLens('Drop')
    await forgetOpenLens()

    await screen.findByText('Drop moved to Archive')
    expect(lensNames(vault.bin)).toEqual(['Drop'])
    await openArchive()
    await screen.findByText('Drop')
  })

  it('shows the empty state when the only Lens is forgotten', async () => {
    seedVault({ lenses: [fakeLens('l1', 'Solo')] })
    await unlock()
    await openLens('Solo')
    await forgetOpenLens()

    await screen.findByText('No Lenses yet')
  })
})

describe('the Archive', () => {
  it('deletes a Lens for good, after asking', async () => {
    const vault = seedVault({
      lenses: [fakeLens('l1', 'Keep')],
      bin: [fakeLens('b1', 'Gone', { deletedAt: new Date().toISOString() })],
    })
    await unlock()
    await openArchive()
    fireEvent.click(await screen.findByRole('button', { name: 'Delete Gone now' }))
    // Deleting for good can't be undone, so it asks first.
    expect(vault.calls).not.toContain('deleteLensForever')
    fireEvent.click(await screen.findByRole('button', { name: 'Delete forever' }))

    await screen.findByText('Archive is empty')
    expect(vault.bin).toEqual([])
  })

  it('restores a Lens', async () => {
    const vault = seedVault({
      lenses: [fakeLens('l1', 'Keep')],
      bin: [fakeLens('b1', 'Back', { deletedAt: new Date().toISOString() }), fakeLens('b2', 'Stays', { deletedAt: new Date().toISOString() })],
    })
    await unlock()
    await openArchive()
    fireEvent.click(await screen.findByRole('button', { name: 'Restore Back' }))

    await screen.findByText('Back restored')
    expect(lensNames(vault.lenses)).toEqual(['Back', 'Keep'])
    expect(lensNames(vault.bin)).toEqual(['Stays'])
  })

  it('shows how many days an archived Lens has left', async () => {
    seedVault({ lenses: [fakeLens('l1', 'Keep')], bin: [fakeLens('b1', 'Old', { deletedAt: new Date(Date.now() - 5 * DAY).toISOString() })] })
    await unlock()
    await openArchive()
    await screen.findByText('Old')
    expect(screen.getByText(/2 days/)).toBeTruthy()
  })
})

describe('Lenses that cannot be opened (B2)', () => {
  it('says how many could not be opened, and still saves new Lenses', async () => {
    const vault = seedVault({ lenses: [fakeLens('l1', 'Good'), fakeLens('l2', 'Broken', { unreadable: true })] })
    await unlock()

    await screen.findByText("1 Lens couldn't be opened. It's kept safe and unchanged.")
    expect(screen.queryByText('Broken')).toBeNull()
    await createLens('New')
    await screen.findByRole('heading', { name: 'New', level: 1 })
    expect(lensNames(vault.lenses)).toEqual(['New', 'Good', 'Broken'])
  })
})

describe('creating a vault (B4)', () => {
  async function createVault(password: string) {
    render(createElement(StillHome))
    fireEvent.change(await screen.findByLabelText('Master password'), { target: { value: password } })
    fireEvent.change(screen.getByLabelText('Confirm password'), { target: { value: password } })
    fireEvent.click(screen.getByRole('button', { name: 'Create vault' }))
    await screen.findByRole('button', { name: /^Archive/ })
  }

  it('refuses a new master password made only of spaces', async () => {
    const vault = freshInstall()
    render(createElement(StillHome))
    fireEvent.change(await screen.findByLabelText('Master password'), { target: { value: '          ' } })
    fireEvent.change(screen.getByLabelText('Confirm password'), { target: { value: '          ' } })
    // Said as soon as it's typed, and the button stays disabled.
    await screen.findByText("A password can't be only spaces.")
    const create = screen.getByRole('button', { name: 'Create vault' }) as HTMLButtonElement
    expect(create.disabled).toBe(true)
    fireEvent.click(create)
    expect(vault.calls).not.toContain('create')
  })

  it('creates a vault and its first Lens on a clean install', async () => {
    const vault = freshInstall()
    await createVault('new-password-1')
    await createLens('Fresh')

    await screen.findByRole('heading', { name: 'Fresh', level: 1 })
    expect(vault.password).toBe('new-password-1')
    expect(lensNames(vault.lenses)).toEqual(['Fresh'])
  })

  it('stays locked when a Lock lands while the vault is being created', async () => {
    const vault = freshInstall()
    vault.lockDuringCreate = true
    render(createElement(StillHome))
    fireEvent.change(await screen.findByLabelText('Master password'), { target: { value: 'new-password-1' } })
    fireEvent.change(screen.getByLabelText('Confirm password'), { target: { value: 'new-password-1' } })
    fireEvent.click(screen.getByRole('button', { name: 'Create vault' }))

    await screen.findByPlaceholderText('Master password')
    expect(screen.queryByRole('button', { name: /^Archive/ })).toBeNull()
    await enterPassword('new-password-1')
    await screen.findByRole('button', { name: /^Archive/ })
  })

  it('offers to create a vault if start-up couldn\'t tell there was none', async () => {
    const vault = freshInstall()
    vault.failState = true
    render(createElement(StillHome))
    await screen.findByPlaceholderText('Master password')
    vault.failState = false
    await enterPassword('anything')

    await screen.findByLabelText('Confirm password')
  })

  it('shows the recovery screen for data it can\'t open, and changes nothing', async () => {
    const vault = freshInstall()
    vault.orphaned = true
    render(createElement(StillHome))

    await screen.findByText("Still found data it can't open")
    expect(screen.queryByLabelText('Master password')).toBeNull()
    expect(vault.calls).toEqual(['lock', 'state'])
  })

  it('changes nothing if the user cancels setting the data aside', async () => {
    const vault = freshInstall()
    vault.orphaned = true
    render(createElement(StillHome))
    fireEvent.click(await screen.findByRole('button', { name: 'Set the old data aside…' }))
    await screen.findByText('Set the old data aside?')
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }))

    await screen.findByText("Still found data it can't open")
    expect(vault.calls).toEqual(['lock', 'state'])
  })

  it('sets the old data aside after confirmation, then starts a new vault', async () => {
    const vault = freshInstall()
    vault.orphaned = true
    render(createElement(StillHome))
    fireEvent.click(await screen.findByRole('button', { name: 'Set the old data aside…' }))
    fireEvent.click(await screen.findByRole('button', { name: 'Set aside and start fresh' }))

    await screen.findByLabelText('Master password')
    expect(vault.setAsides).toHaveLength(1)
    fireEvent.change(screen.getByLabelText('Master password'), { target: { value: 'new-password-1' } })
    fireEvent.change(screen.getByLabelText('Confirm password'), { target: { value: 'new-password-1' } })
    fireEvent.click(screen.getByRole('button', { name: 'Create vault' }))
    await screen.findByRole('button', { name: /^Archive/ })
    await createLens('Fresh')

    await screen.findByRole('heading', { name: 'Fresh', level: 1 })
    expect(vault.calls.filter((c) => c === 'setAside' || c === 'create')).toEqual(['setAside', 'create'])
  })
})

describe('PIN (B6)', () => {
  it('offers no PIN when creating a vault', async () => {
    freshInstall()
    render(createElement(StillHome))
    await screen.findByLabelText('Master password')

    expect(screen.queryByRole('button', { name: 'Add PIN' })).toBeNull()
  })

  it('offers no PIN on the unlock screen', async () => {
    seedVault({ lenses: [fakeLens('l1', 'Alpha')] })
    render(createElement(StillHome))
    await screen.findByPlaceholderText('Master password')

    expect(screen.queryByRole('button', { name: 'Use PIN instead' })).toBeNull()
  })
})
