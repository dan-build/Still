// @vitest-environment happy-dom
//
// UI tests for src/app/App.tsx: they drive the real UI and check what ends up in
// localStorage. Crypto is replaced by src/test/fakeCrypto.ts, which produces
// real v1 blob shapes quickly; crypto.golden.test.ts and crypto.vectors.test.ts
// cover the real thing.
//
// `it.fails` marks known bugs from AUDIT.md. The test body says what should
// happen; it fails today. When a fix lands, change `it.fails` to `it` in the
// same commit. Each `it.fails` has a passing sibling that runs the same steps,
// so a broken step can't make a known-bug test "pass" by accident.

import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { createElement } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { fakeItemBlob, fakeLensKeyBlob, fakeMasterKeyBlob, fakePlaintext } from '@/test/fakeCrypto'

// The app's crypto is the Rust one behind Tauri commands. Here it's the JS
// VaultCrypto on fake crypto, with its calls to lock recorded.
const lockCalls = vi.hoisted(() => ({ count: 0 }))
const clipboard = vi.hoisted(() => ({ copied: [] as string[] }))
// Rust's auto-lock: the test can fire the vault-locked event and count activity reports.
const autoLock = vi.hoisted(() => ({ fire: undefined as undefined | ((reason: 'idle' | 'sleep') => void), activity: 0 }))
vi.mock('@/platform/tauri/session', () => ({
  reportActivity: () => { autoLock.activity += 1 },
  onAutoLocked: (onLocked: (reason: 'idle' | 'sleep') => void) => {
    autoLock.fire = onLocked
    return () => { if (autoLock.fire === onLocked) autoLock.fire = undefined }
  },
}))
vi.mock('@/platform/tauri/vaultCrypto', async () => {
  const fake = await import('@/test/fakeCrypto')
  const { createLibsodiumVaultCrypto } = await import('@/test/reference/libsodiumVaultCrypto')
  return {
    createTauriVaultCrypto: () => {
      const crypto = createLibsodiumVaultCrypto(fake, (text) => clipboard.copied.push(text))
      return { ...crypto, lock: () => { lockCalls.count += 1; return crypto.lock() } }
    },
  }
})

import { localStorageVault } from '@/test/localStorageVault'
import StillHome from './App'

// ---- fixtures ---------------------------------------------------------------

const PASSWORD = 'test-password-1'
const SALT = new Uint8Array(16).fill(7)
const APP_KEY = new Uint8Array(32).fill(0xa1)
const OTHER_APP_KEY = new Uint8Array(32).fill(0xb2)
const DAY = 24 * 60 * 60 * 1000

type SeedLens = { id: string; name: string; deletedAt?: string; wrappedWith?: Uint8Array }

const lensKeyFor = (id: string) => new Uint8Array(Buffer.from(id.padEnd(32, '#').slice(0, 32)))

function persisted({ id, name, deletedAt, wrappedWith = APP_KEY }: SeedLens) {
  const lensKey = lensKeyFor(id)
  return {
    id,
    name,
    createdAt: '2026-01-01T00:00:00.000Z',
    itemCount: 1,
    encryptedMasterKey: fakeLensKeyBlob(lensKey, wrappedWith),
    items: [{ id: `${id}-item`, label: `${name} secret`, type: 'password', encryptedValue: fakeItemBlob(`value-of-${id}`, lensKey) }],
    ...(deletedAt ? { deletedAt } : {}),
  }
}

function seedVault({
  lenses = [],
  bin = [],
  password = PASSWORD,
  hasPin = false,
  masterKeyBlob,
}: { lenses?: SeedLens[]; bin?: SeedLens[]; password?: string; hasPin?: boolean; masterKeyBlob?: string }) {
  localStorage.setItem('still-encrypted-master-key', masterKeyBlob ?? fakeMasterKeyBlob(APP_KEY, password, SALT))
  localStorage.setItem('still-salt', Buffer.from(SALT).toString('base64'))
  localStorage.setItem('still-has-pin', hasPin ? 'true' : 'false')
  localStorage.setItem('still-lenses', JSON.stringify(lenses.map(persisted)))
  localStorage.setItem('still-recycle-bin', JSON.stringify(bin.map(persisted)))
}

type StoredLens = { id: string; name: string; items: { id: string; label: string; type: string; encryptedValue: string }[] }

const stored = (key: 'still-lenses' | 'still-recycle-bin'): StoredLens[] =>
  JSON.parse(localStorage.getItem(key) ?? 'null')
const storedNames = (key: 'still-lenses' | 'still-recycle-bin') => (stored(key) ?? []).map((lens) => lens.name)
const storedItems = (lensName: string) => (stored('still-lenses') ?? []).find((lens) => lens.name === lensName)?.items ?? []

// ---- UI steps ---------------------------------------------------------------

async function enterPassword(password = PASSWORD) {
  fireEvent.change(await screen.findByPlaceholderText('Master password'), { target: { value: password } })
  fireEvent.click(screen.getByRole('button', { name: 'Unlock' }))
}

async function unlock(password = PASSWORD) {
  render(createElement(StillHome, { storage: localStorageVault(localStorage) }))
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

// vi.restoreAllMocks() does not undo a spy on happy-dom's localStorage, but
// the spy's own mockRestore() does, so storage spies are tracked here.
const storageSpies: { mockRestore(): void }[] = []
function spyOnStorage() {
  const spy = vi.spyOn(localStorage, 'setItem')
  storageSpies.push(spy)
  return spy
}

beforeEach(() => localStorage.clear())
afterEach(() => {
  cleanup()
  for (const spy of storageSpies.splice(0)) spy.mockRestore()
  vi.restoreAllMocks()
})

// ---- tests ------------------------------------------------------------------

describe('unlock', () => {
  it('loads every Lens and never writes fewer Lenses than storage holds', async () => {
    seedVault({ lenses: [{ id: 'l1', name: 'Alpha' }, { id: 'l2', name: 'Beta' }] })
    const before = localStorage.getItem('still-lenses')
    // Spy on the localStorage object itself: in happy-dom a spy on
    // Storage.prototype.setItem never sees a call.
    const setItem = spyOnStorage()

    await unlock()
    await screen.findAllByText('Alpha')
    await screen.findAllByText('Beta')

    const lensWrites = setItem.mock.calls.filter(([key]) => key === 'still-lenses')
    for (const [, value] of lensWrites) expect(JSON.parse(value)).toHaveLength(2)
    expect(localStorage.getItem('still-lenses')).toBe(before)

    // The spy is live: a real change afterwards is seen.
    await createLens('Gamma')
    await waitFor(() =>
      expect(setItem.mock.calls.some(([key, value]) => key === 'still-lenses' && JSON.parse(value).length === 3)).toBe(true),
    )
  })

  it('shows an error and stays locked on a wrong password', async () => {
    seedVault({ lenses: [{ id: 'l1', name: 'Alpha' }] })
    render(createElement(StillHome, { storage: localStorageVault(localStorage) }))
    await enterPassword('not-the-password')

    await screen.findByText('Incorrect password. Try again.')
    expect(screen.queryByRole('button', { name: /^Archive/ })).toBeNull()
  })

  it('unlocks a vault whose password is only spaces (B7)', async () => {
    seedVault({ lenses: [{ id: 'l1', name: 'Alpha' }], password: '        ' })
    await unlock('        ')
  })

  it('reports unreadable vault data differently from a wrong password (S4)', async () => {
    const truncated = Buffer.from(new Uint8Array(40).fill(1)).toString('base64')
    seedVault({ lenses: [{ id: 'l1', name: 'Alpha' }], masterKeyBlob: truncated })
    render(createElement(StillHome, { storage: localStorageVault(localStorage) }))
    await enterPassword()

    await screen.findByText(/couldn.t read this vault/i)
  })
})

describe('after the vault moved into its file', () => {
  it('says so on the unlock screen, and keeps saying it until dismissed', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true })
    try {
      seedVault({ lenses: [{ id: 'l1', name: 'Alpha' }] })
      render(createElement(StillHome, { storage: localStorageVault(localStorage), notice: 'moved' }))
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
      seedVault({ lenses: [{ id: 'l1', name: 'Alpha' }] })
      await unlock()
      await openLens('Alpha')
      act(() => autoLock.fire!(reason))

      await screen.findByPlaceholderText('Master password')
      expect(screen.getByRole('status').textContent).toContain(message)
      expect(screen.queryByText('Alpha')).toBeNull()
    })
  }

  it('reports activity at most every 15 seconds, and only while unlocked', async () => {
    seedVault({ lenses: [{ id: 'l1', name: 'Alpha' }] })
    render(createElement(StillHome, { storage: localStorageVault(localStorage) }))
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
  it('has the crypto forget any keys as soon as the app starts', async () => {
    seedVault({ lenses: [{ id: 'l1', name: 'Alpha' }] })
    lockCalls.count = 0
    render(createElement(StillHome, { storage: localStorageVault(localStorage) }))
    await screen.findByPlaceholderText('Master password')
    expect(lockCalls.count).toBeGreaterThan(0)
  })

  it('returns to the unlock screen', async () => {
    seedVault({ lenses: [{ id: 'l1', name: 'Alpha' }] })
    await unlock()
    fireEvent.click(screen.getByRole('button', { name: 'Lock' }))

    await screen.findByPlaceholderText('Master password')
    expect(screen.queryByRole('button', { name: /^Archive/ })).toBeNull()
  })

  it('closes the open Lens, so it is not shown again after unlocking (S1)', async () => {
    seedVault({ lenses: [{ id: 'l1', name: 'Alpha' }] })
    await unlock()
    await openLens('Alpha')
    fireEvent.click(screen.getByRole('button', { name: 'Lock' }))
    await enterPassword()
    await screen.findByRole('button', { name: /^Archive/ })

    expect(screen.queryByRole('button', { name: 'Forget Lens' })).toBeNull()
  })
})

describe('secrets', () => {
  it('adds a secret and saves it encrypted', async () => {
    seedVault({ lenses: [{ id: 'l1', name: 'Alpha' }] })
    await unlock()
    await openLens('Alpha')
    await addSecret('GitHub', 'ghp-123')

    await waitFor(() => expect(storedItems('Alpha').map((item) => item.label)).toContain('GitHub'))
    const item = storedItems('Alpha').find((i) => i.label === 'GitHub')!
    expect(item.encryptedValue).not.toContain('ghp-123')
    expect(fakePlaintext(item.encryptedValue)).toBe('ghp-123')
  })

  it('stores a secret exactly as typed, including edge spaces and line breaks (B3)', async () => {
    seedVault({ lenses: [{ id: 'l1', name: 'Alpha' }] })
    await unlock()
    await openLens('Alpha')
    await addSecret('Spaced', '  spaced out \n')

    await waitFor(() => expect(storedItems('Alpha').map((item) => item.label)).toContain('Spaced'))
    const item = storedItems('Alpha').find((i) => i.label === 'Spaced')!
    expect(fakePlaintext(item.encryptedValue)).toBe('  spaced out \n')
  })

  it('points out edge spaces and removes them on request', async () => {
    seedVault({ lenses: [{ id: 'l1', name: 'Alpha' }] })
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
    await waitFor(() => expect(storedItems('Alpha').map((i) => i.label)).toContain('Token'))
    expect(fakePlaintext(storedItems('Alpha').find((i) => i.label === 'Token')!.encryptedValue)).toBe('tok-123')
  })

  it('refuses a secret that is only spaces or line breaks, and says why', async () => {
    seedVault({ lenses: [{ id: 'l1', name: 'Alpha' }] })
    await unlock()
    await openLens('Alpha')
    openAddSecret()
    fireEvent.change(await screen.findByPlaceholderText('What is this for?'), { target: { value: 'Blank' } })
    fireEvent.change(screen.getByPlaceholderText('Paste or type the secret here…'), { target: { value: '  \n ' } })

    await screen.findByText("A secret can't be only spaces or line breaks.")
    expect((screen.getByRole('button', { name: 'Add secret' }) as HTMLButtonElement).disabled).toBe(true)
  })

  it('turns off spellcheck and autocorrect for the secret value', async () => {
    seedVault({ lenses: [{ id: 'l1', name: 'Alpha' }] })
    await unlock()
    await openLens('Alpha')
    openAddSecret()
    const value = await screen.findByPlaceholderText('Paste or type the secret here…')

    expect(value.getAttribute('spellcheck')).toBe('false')
    expect(value.getAttribute('autocorrect')).toBe('off')
    expect(value.getAttribute('autocomplete')).toBe('off')
  })

  it('copies a secret without revealing it in the page', async () => {
    seedVault({ lenses: [{ id: 'l1', name: 'Alpha' }] })
    clipboard.copied = []
    const writeText = vi.fn()
    Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true })
    await unlock()
    await openLens('Alpha')
    fireEvent.click(screen.getByRole('button', { name: 'Copy Alpha secret' }))

    await screen.findByText('Alpha secret copied')
    expect(clipboard.copied).toEqual(['value-of-l1'])
    expect(writeText).not.toHaveBeenCalled()
    expect(screen.queryByText('value-of-l1')).toBeNull()
  })

  it('reveals a saved secret', async () => {
    seedVault({ lenses: [{ id: 'l1', name: 'Alpha' }] })
    await unlock()
    await openLens('Alpha')
    fireEvent.click(screen.getByRole('button', { name: 'Reveal Alpha secret' }))

    await screen.findByText('value-of-l1')
  })

  it('shows a revealed secret with its spaces and line breaks intact', async () => {
    seedVault({ lenses: [{ id: 'l1', name: 'Alpha' }] })
    await unlock()
    await openLens('Alpha')
    await addSecret('Spaced', '  two-spaces-in-front\nsecond line')
    await waitFor(() => expect(storedItems('Alpha').map((i) => i.label)).toContain('Spaced'))
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

  it('deletes a secret and saves the change', async () => {
    seedVault({ lenses: [{ id: 'l1', name: 'Alpha' }] })
    await unlock()
    await openLens('Alpha')
    fireEvent.click(screen.getByRole('button', { name: 'Delete Alpha secret' }))
    // Deleting can't be undone, so it asks first.
    expect(storedItems('Alpha')).toHaveLength(1)
    fireEvent.click(await screen.findByRole('button', { name: 'Delete secret' }))

    await waitFor(() => expect(storedItems('Alpha')).toEqual([]))
    expect(storedNames('still-lenses')).toEqual(['Alpha'])
  })
})

describe('failed saves (B5)', () => {
  function failWritesTo(failing: string) {
    const original = localStorage.setItem.bind(localStorage)
    return spyOnStorage().mockImplementation((key: string, value: string) => {
      if (key === failing) throw new DOMException('The quota has been exceeded.', 'QuotaExceededError')
      original(key, value)
    })
  }

  it('shows an error when a secret can\'t be saved, and changes nothing', async () => {
    seedVault({ lenses: [{ id: 'l1', name: 'Alpha' }] })
    await unlock()
    await openLens('Alpha')
    const before = localStorage.getItem('still-lenses')
    const spy = failWritesTo('still-lenses')
    await addSecret('Unsaved', 'v')

    await waitFor(() => expect(screen.getByRole('alert').textContent).toContain("Couldn't save the secret. Nothing was changed."))
    expect(localStorage.getItem('still-lenses')).toBe(before)
    expect(screen.queryByText('Unsaved')).toBeNull()

    spy.mockRestore()
    fireEvent.click(await screen.findByRole('button', { name: 'Add secret' }))
    await waitFor(() => expect(storedItems('Alpha').map((i) => i.label)).toContain('Unsaved'))
  })

  it('keeps a Lens where it was when forgetting it can\'t be saved', async () => {
    seedVault({ lenses: [{ id: 'l1', name: 'Keep' }, { id: 'l2', name: 'Drop' }] })
    await unlock()
    const before = { lenses: localStorage.getItem('still-lenses'), bin: localStorage.getItem('still-recycle-bin') }
    await openLens('Drop')
    failWritesTo('still-lenses')
    await forgetOpenLens()

    await waitFor(() => expect(screen.getByRole('alert').textContent).toContain("Couldn't save that change. Nothing was changed."))
    expect({ lenses: localStorage.getItem('still-lenses'), bin: localStorage.getItem('still-recycle-bin') }).toEqual(before)
    expect(screen.getAllByText('Drop').length).toBeGreaterThan(0)
  })
})

describe('forgetting a Lens (B1)', () => {
  it('moves one of two Lenses to the bin in storage', async () => {
    seedVault({ lenses: [{ id: 'l1', name: 'Keep' }, { id: 'l2', name: 'Drop' }] })
    await unlock()
    await openLens('Drop')
    await forgetOpenLens()

    await waitFor(() => expect(storedNames('still-recycle-bin')).toEqual(['Drop']))
    expect(storedNames('still-lenses')).toEqual(['Keep'])
  })

  it('persists an empty Lens list when the only Lens is forgotten', async () => {
    seedVault({ lenses: [{ id: 'l1', name: 'Solo' }] })
    await unlock()
    await openLens('Solo')
    await forgetOpenLens()

    await waitFor(() => expect(storedNames('still-recycle-bin')).toEqual(['Solo']))
    expect(stored('still-lenses')).toEqual([])
  })
})

describe('the recycle bin (B1)', () => {
  it('persists "Delete forever" while other bin entries remain', async () => {
    seedVault({
      lenses: [{ id: 'l1', name: 'Keep' }],
      bin: [{ id: 'b1', name: 'Gone', deletedAt: new Date().toISOString() }, { id: 'b2', name: 'Stays', deletedAt: new Date().toISOString() }],
    })
    await unlock()
    await openArchive()
    fireEvent.click(await screen.findByRole('button', { name: 'Delete Gone now' }))
    fireEvent.click(await screen.findByRole('button', { name: 'Delete forever' }))

    await waitFor(() => expect(storedNames('still-recycle-bin')).toEqual(['Stays']))
  })

  it('persists "Delete forever" on the last bin entry', async () => {
    seedVault({ lenses: [{ id: 'l1', name: 'Keep' }], bin: [{ id: 'b1', name: 'Gone', deletedAt: new Date().toISOString() }] })
    await unlock()
    await openArchive()
    fireEvent.click(await screen.findByRole('button', { name: 'Delete Gone now' }))
    // Deleting for good can't be undone, so it asks first.
    expect(storedNames('still-recycle-bin')).toEqual(['Gone'])
    fireEvent.click(await screen.findByRole('button', { name: 'Delete forever' }))

    await screen.findByText('Archive is empty')
    await waitFor(() => expect(stored('still-recycle-bin')).toEqual([]))
  })

  it('persists restoring one of two bin entries', async () => {
    seedVault({
      lenses: [{ id: 'l1', name: 'Keep' }],
      bin: [{ id: 'b1', name: 'Back', deletedAt: new Date().toISOString() }, { id: 'b2', name: 'Stays', deletedAt: new Date().toISOString() }],
    })
    await unlock()
    await openArchive()
    fireEvent.click(await screen.findByRole('button', { name: 'Restore Back' }))

    await waitFor(() => expect(storedNames('still-lenses').sort()).toEqual(['Back', 'Keep']))
    await waitFor(() => expect(storedNames('still-recycle-bin')).toEqual(['Stays']))
  })

  it('persists restoring the last bin entry', async () => {
    seedVault({ lenses: [{ id: 'l1', name: 'Keep' }], bin: [{ id: 'b1', name: 'Back', deletedAt: new Date().toISOString() }] })
    await unlock()
    await openArchive()
    fireEvent.click(await screen.findByRole('button', { name: 'Restore Back' }))

    await waitFor(() => expect(storedNames('still-lenses').sort()).toEqual(['Back', 'Keep']))
    await waitFor(() => expect(stored('still-recycle-bin')).toEqual([]))
  })

  it('purges entries older than 7 days from storage while newer ones remain', async () => {
    seedVault({
      lenses: [{ id: 'l1', name: 'Keep' }],
      bin: [{ id: 'b1', name: 'Old', deletedAt: new Date(Date.now() - 8 * DAY).toISOString() }, { id: 'b2', name: 'Recent', deletedAt: new Date().toISOString() }],
    })
    await unlock()
    await openArchive()
    await screen.findByText('Recent')

    await waitFor(() => expect(storedNames('still-recycle-bin')).toEqual(['Recent']))
  })

  it('persists the 7-day purge when it empties the bin', async () => {
    seedVault({ lenses: [{ id: 'l1', name: 'Keep' }], bin: [{ id: 'b1', name: 'Old', deletedAt: new Date(Date.now() - 8 * DAY).toISOString() }] })
    await unlock()
    await openArchive()
    await screen.findByText('Archive is empty')

    await waitFor(() => expect(stored('still-recycle-bin')).toEqual([]))
  })
})

describe('Lenses that cannot be decrypted (B2)', () => {
  it('saves a newly created Lens next to the existing ones', async () => {
    seedVault({ lenses: [{ id: 'l1', name: 'Good' }] })
    await unlock()
    await screen.findAllByText('Good')
    await createLens('New')

    await waitFor(() => expect(storedNames('still-lenses').sort()).toEqual(['Good', 'New']))
  })

  it('keeps an unreadable Lens in storage after an unrelated edit', async () => {
    seedVault({ lenses: [{ id: 'l1', name: 'Good' }, { id: 'l2', name: 'Broken', wrappedWith: OTHER_APP_KEY }] })
    await unlock()
    await screen.findAllByText('Good')
    await createLens('New')

    await waitFor(() => expect(storedNames('still-lenses')).toContain('New'))
    expect(storedNames('still-lenses')).toContain('Broken')
  })
  it('tells the user a Lens could not be opened and keeps it unchanged', async () => {
    seedVault({ lenses: [{ id: 'l1', name: 'Good' }, { id: 'l2', name: 'Broken', wrappedWith: OTHER_APP_KEY }] })
    const before = stored('still-lenses').find((l) => l.name === 'Broken')
    await unlock()

    await screen.findByText("1 Lens couldn't be opened. It's kept safe and unchanged.")
    expect(screen.queryByText('Broken')).toBeNull()
    await createLens('New')
    await waitFor(() => expect(storedNames('still-lenses')).toContain('New'))
    expect(stored('still-lenses').find((l) => l.name === 'Broken')).toEqual(before)
  })
})

describe('creating a vault (B4)', () => {
  async function createVault(password: string) {
    render(createElement(StillHome, { storage: localStorageVault(localStorage) }))
    fireEvent.change(await screen.findByLabelText('Master password'), { target: { value: password } })
    fireEvent.change(screen.getByLabelText('Confirm password'), { target: { value: password } })
    fireEvent.click(screen.getByRole('button', { name: 'Create vault' }))
    await screen.findByRole('button', { name: /^Archive/ })
  }

  it('refuses a new master password made only of spaces', async () => {
    render(createElement(StillHome, { storage: localStorageVault(localStorage) }))
    fireEvent.change(await screen.findByLabelText('Master password'), { target: { value: '          ' } })
    fireEvent.change(screen.getByLabelText('Confirm password'), { target: { value: '          ' } })
    // Said as soon as it's typed, and the button stays disabled.
    await screen.findByText("A password can't be only spaces.")
    const create = screen.getByRole('button', { name: 'Create vault' }) as HTMLButtonElement
    expect(create.disabled).toBe(true)
    fireEvent.click(create)
    expect(localStorage.getItem('still-encrypted-master-key')).toBeNull()
  })

  it('creates a vault and saves its first Lens on a clean install', async () => {
    await createVault('new-password-1')
    await createLens('Fresh')

    await waitFor(() => expect(storedNames('still-lenses')).toEqual(['Fresh']))
    expect(localStorage.getItem('still-encrypted-master-key')).toMatch(/^[A-Za-z0-9+/]+={0,2}$/)
  })

  function snapshot() {
    return Object.fromEntries(Object.keys(localStorage).map((key) => [key, localStorage.getItem(key)]))
  }

  it('does not destroy existing Lenses when the master key is missing', async () => {
    localStorage.setItem('still-lenses', JSON.stringify([persisted({ id: 'o1', name: 'Orphan' })]))
    const before = snapshot()
    render(createElement(StillHome, { storage: localStorageVault(localStorage) }))

    await screen.findByText("Still found data it can't open")
    expect(screen.queryByLabelText('Master password')).toBeNull()
    expect(snapshot()).toEqual(before)
  })

  it('treats a master key without its salt as data it can\'t open', async () => {
    seedVault({ lenses: [{ id: 'l1', name: 'Alpha' }] })
    localStorage.removeItem('still-salt')
    render(createElement(StillHome, { storage: localStorageVault(localStorage) }))

    await screen.findByText("Still found data it can't open")
  })

  it('offers a normal new vault when leftover lists are empty', async () => {
    localStorage.setItem('still-lenses', '[]')
    localStorage.setItem('still-recycle-bin', '[]')
    render(createElement(StillHome, { storage: localStorageVault(localStorage) }))

    await screen.findByLabelText('Master password')
  })

  it('changes nothing if the user cancels setting the data aside', async () => {
    localStorage.setItem('still-lenses', JSON.stringify([persisted({ id: 'o1', name: 'Orphan' })]))
    const before = snapshot()
    render(createElement(StillHome, { storage: localStorageVault(localStorage) }))
    fireEvent.click(await screen.findByRole('button', { name: 'Set the old data aside…' }))
    await screen.findByText('Set the old data aside?')
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }))

    await screen.findByText("Still found data it can't open")
    expect(snapshot()).toEqual(before)
  })

  it('sets the old data aside after confirmation, keeping every value, then starts a new vault', async () => {
    const orphan = JSON.stringify([persisted({ id: 'o1', name: 'Orphan' })])
    localStorage.setItem('still-lenses', orphan)
    localStorage.setItem('still-has-pin', 'false')
    render(createElement(StillHome, { storage: localStorageVault(localStorage) }))
    fireEvent.click(await screen.findByRole('button', { name: 'Set the old data aside…' }))
    fireEvent.click(await screen.findByRole('button', { name: 'Set aside and start fresh' }))

    await screen.findByLabelText('Master password')
    const keptLenses = Object.keys(localStorage).find((key) => /^still-set-aside-.*-still-lenses$/.test(key))!
    expect(localStorage.getItem(keptLenses)).toBe(orphan)
    expect(Object.keys(localStorage).some((key) => /^still-set-aside-.*-still-has-pin$/.test(key))).toBe(true)
    expect(localStorage.getItem('still-lenses')).toBeNull()

    fireEvent.change(screen.getByLabelText('Master password'), { target: { value: 'new-password-1' } })
    fireEvent.change(screen.getByLabelText('Confirm password'), { target: { value: 'new-password-1' } })
    fireEvent.click(screen.getByRole('button', { name: 'Create vault' }))
    await screen.findByRole('button', { name: /^Archive/ })
    await createLens('Fresh')

    await waitFor(() => expect(storedNames('still-lenses')).toEqual(['Fresh']))
    expect(localStorage.getItem(keptLenses)).toBe(orphan)
  })
})

describe('PIN (B6)', () => {
  it('offers no PIN when creating a vault', async () => {
    render(createElement(StillHome, { storage: localStorageVault(localStorage) }))
    await screen.findByLabelText('Master password')

    expect(screen.queryByRole('button', { name: 'Add PIN' })).toBeNull()
  })

  it('offers no PIN on the unlock screen, even for vaults saved with the PIN flag', async () => {
    seedVault({ lenses: [{ id: 'l1', name: 'Alpha' }], hasPin: true })
    render(createElement(StillHome, { storage: localStorageVault(localStorage) }))
    await screen.findByPlaceholderText('Master password')

    expect(screen.queryByRole('button', { name: 'Use PIN instead' })).toBeNull()
  })
})
