// @vitest-environment happy-dom
//
// UI tests for app/page.tsx: they drive the real UI and check what ends up in
// localStorage. Crypto is replaced by app/test/fakeCrypto.ts, which produces
// real v1 blob shapes quickly; crypto.golden.test.ts and crypto.vectors.test.ts
// cover the real thing.
//
// `it.fails` marks known bugs from AUDIT.md. The test body says what should
// happen; it fails today. When a fix lands, change `it.fails` to `it` in the
// same commit. Each `it.fails` has a passing sibling that runs the same steps,
// so a broken step can't make a known-bug test "pass" by accident.

import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { createElement } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { fakeItemBlob, fakeLensKeyBlob, fakeMasterKeyBlob, fakePlaintext } from './test/fakeCrypto'

vi.mock('next/image', () => ({
  default: ({ src, alt }: { src: string; alt: string }) => createElement('img', { src, alt }),
}))

vi.mock('./lib/crypto', () => import('./test/fakeCrypto'))

import StillHome from './page'

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
  fireEvent.change(await screen.findByPlaceholderText('Enter your password'), { target: { value: password } })
  fireEvent.click(screen.getByRole('button', { name: 'Unlock' }))
}

async function unlock(password = PASSWORD) {
  render(createElement(StillHome))
  await enterPassword(password)
  await screen.findByRole('button', { name: 'Archive' })
}

async function openLens(name: string) {
  fireEvent.click((await screen.findAllByText(name))[0])
  await screen.findByRole('button', { name: 'Forget Lens' })
}

async function forgetOpenLens() {
  fireEvent.click(screen.getByRole('button', { name: 'Forget Lens' }))
  fireEvent.click(await screen.findByRole('button', { name: 'Move to Recycle Bin' }))
}

async function openArchive() {
  fireEvent.click(screen.getByRole('button', { name: 'Archive' }))
  await screen.findByText('Recycle Bin')
}

async function createLens(name: string) {
  fireEvent.click(screen.getByRole('button', { name: 'New Lens' }))
  fireEvent.change(await screen.findByPlaceholderText('e.g. Banking Keys'), { target: { value: name } })
  fireEvent.click(screen.getByRole('button', { name: 'Create Lens' }))
}

async function addSecret(label: string, value: string) {
  fireEvent.click(screen.getByRole('button', { name: 'Add Secret' }))
  fireEvent.change(await screen.findByPlaceholderText('What is this for?'), { target: { value: label } })
  fireEvent.change(screen.getByPlaceholderText('Paste or type the secret here…'), { target: { value } })
  fireEvent.click(screen.getByRole('button', { name: 'Add to Lens' }))
}

beforeEach(() => localStorage.clear())
afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
})

// ---- tests ------------------------------------------------------------------

describe('unlock', () => {
  it('loads every Lens and never writes fewer Lenses than storage holds', async () => {
    seedVault({ lenses: [{ id: 'l1', name: 'Alpha' }, { id: 'l2', name: 'Beta' }] })
    const setItem = vi.spyOn(Storage.prototype, 'setItem')

    await unlock()
    await screen.findAllByText('Alpha')
    await screen.findAllByText('Beta')

    const lensWrites = setItem.mock.calls.filter(([key]) => key === 'still-lenses')
    for (const [, value] of lensWrites) expect(JSON.parse(value)).toHaveLength(2)
    expect(storedNames('still-lenses').sort()).toEqual(['Alpha', 'Beta'])
  })

  it('shows an error and stays locked on a wrong password', async () => {
    seedVault({ lenses: [{ id: 'l1', name: 'Alpha' }] })
    render(createElement(StillHome))
    await enterPassword('not-the-password')

    await screen.findByText('Incorrect password or PIN')
    expect(screen.queryByRole('button', { name: 'Archive' })).toBeNull()
  })

  it.fails('unlocks a vault whose password is only spaces (B7)', async () => {
    seedVault({ lenses: [{ id: 'l1', name: 'Alpha' }], password: '        ' })
    await unlock('        ')
  })

  it.fails('reports unreadable vault data differently from a wrong password (S4)', async () => {
    const truncated = Buffer.from(new Uint8Array(40).fill(1)).toString('base64')
    seedVault({ lenses: [{ id: 'l1', name: 'Alpha' }], masterKeyBlob: truncated })
    render(createElement(StillHome))
    await enterPassword()

    await screen.findByText(/couldn.t read this vault/i)
  })
})

describe('lock', () => {
  it('returns to the unlock screen', async () => {
    seedVault({ lenses: [{ id: 'l1', name: 'Alpha' }] })
    await unlock()
    fireEvent.click(screen.getByRole('button', { name: 'Lock' }))

    await screen.findByPlaceholderText('Enter your password')
    expect(screen.queryByRole('button', { name: 'Archive' })).toBeNull()
  })

  it.fails('closes the open Lens, so it is not shown again after unlocking (S1)', async () => {
    seedVault({ lenses: [{ id: 'l1', name: 'Alpha' }] })
    await unlock()
    await openLens('Alpha')
    fireEvent.click(screen.getByRole('button', { name: 'Lock' }))
    await enterPassword()
    await screen.findByRole('button', { name: 'Archive' })

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

  it.fails('stores a secret exactly as typed, including edge spaces and line breaks (B3)', async () => {
    seedVault({ lenses: [{ id: 'l1', name: 'Alpha' }] })
    await unlock()
    await openLens('Alpha')
    await addSecret('Spaced', '  spaced out \n')

    await waitFor(() => expect(storedItems('Alpha').map((item) => item.label)).toContain('Spaced'))
    const item = storedItems('Alpha').find((i) => i.label === 'Spaced')!
    expect(fakePlaintext(item.encryptedValue)).toBe('  spaced out \n')
  })

  it('reveals a saved secret', async () => {
    seedVault({ lenses: [{ id: 'l1', name: 'Alpha' }] })
    await unlock()
    await openLens('Alpha')
    fireEvent.click(screen.getByRole('button', { name: 'Reveal' }))

    await screen.findByText('value-of-l1')
  })

  it('deletes a secret and saves the change', async () => {
    seedVault({ lenses: [{ id: 'l1', name: 'Alpha' }] })
    await unlock()
    await openLens('Alpha')
    fireEvent.click(screen.getByRole('button', { name: 'Delete' }))

    await waitFor(() => expect(storedItems('Alpha')).toEqual([]))
    expect(storedNames('still-lenses')).toEqual(['Alpha'])
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

  it.fails('persists an empty Lens list when the only Lens is forgotten', async () => {
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
    fireEvent.click((await screen.findAllByRole('button', { name: 'Delete forever' }))[0])

    await waitFor(() => expect(storedNames('still-recycle-bin')).toEqual(['Stays']))
  })

  it.fails('persists "Delete forever" on the last bin entry', async () => {
    seedVault({ lenses: [{ id: 'l1', name: 'Keep' }], bin: [{ id: 'b1', name: 'Gone', deletedAt: new Date().toISOString() }] })
    await unlock()
    await openArchive()
    fireEvent.click(await screen.findByRole('button', { name: 'Delete forever' }))

    await screen.findByText('Recycle Bin is empty')
    await waitFor(() => expect(stored('still-recycle-bin')).toEqual([]))
  })

  it('persists restoring one of two bin entries', async () => {
    seedVault({
      lenses: [{ id: 'l1', name: 'Keep' }],
      bin: [{ id: 'b1', name: 'Back', deletedAt: new Date().toISOString() }, { id: 'b2', name: 'Stays', deletedAt: new Date().toISOString() }],
    })
    await unlock()
    await openArchive()
    fireEvent.click((await screen.findAllByRole('button', { name: 'Restore' }))[0])

    await waitFor(() => expect(storedNames('still-lenses').sort()).toEqual(['Back', 'Keep']))
    await waitFor(() => expect(storedNames('still-recycle-bin')).toEqual(['Stays']))
  })

  it.fails('persists restoring the last bin entry', async () => {
    seedVault({ lenses: [{ id: 'l1', name: 'Keep' }], bin: [{ id: 'b1', name: 'Back', deletedAt: new Date().toISOString() }] })
    await unlock()
    await openArchive()
    fireEvent.click(await screen.findByRole('button', { name: 'Restore' }))

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

  it.fails('persists the 7-day purge when it empties the bin', async () => {
    seedVault({ lenses: [{ id: 'l1', name: 'Keep' }], bin: [{ id: 'b1', name: 'Old', deletedAt: new Date(Date.now() - 8 * DAY).toISOString() }] })
    await unlock()
    await openArchive()
    await screen.findByText('Recycle Bin is empty')

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

  it.fails('keeps an unreadable Lens in storage after an unrelated edit', async () => {
    seedVault({ lenses: [{ id: 'l1', name: 'Good' }, { id: 'l2', name: 'Broken', wrappedWith: OTHER_APP_KEY }] })
    await unlock()
    await screen.findAllByText('Good')
    await createLens('New')

    await waitFor(() => expect(storedNames('still-lenses')).toContain('New'))
    expect(storedNames('still-lenses')).toContain('Broken')
  })
})

describe('creating a vault (B4)', () => {
  async function createVault(password: string) {
    render(createElement(StillHome))
    fireEvent.change(await screen.findByPlaceholderText('Create a strong password'), { target: { value: password } })
    fireEvent.change(screen.getByPlaceholderText('Confirm your password'), { target: { value: password } })
    fireEvent.click(screen.getByRole('button', { name: 'Create Secure Vault' }))
    await screen.findByRole('button', { name: 'Archive' })
  }

  it('creates a vault and saves its first Lens on a clean install', async () => {
    await createVault('new-password-1')
    await createLens('Fresh')

    await waitFor(() => expect(storedNames('still-lenses')).toEqual(['Fresh']))
    expect(localStorage.getItem('still-encrypted-master-key')).toMatch(/^[A-Za-z0-9+/]+={0,2}$/)
  })

  it.fails('does not destroy existing Lenses when the master key is missing', async () => {
    localStorage.setItem('still-lenses', JSON.stringify([persisted({ id: 'o1', name: 'Orphan' })]))
    await createVault('new-password-1')
    await createLens('Fresh')

    await waitFor(() => expect(storedNames('still-lenses')).toContain('Fresh'))
    expect(storedNames('still-lenses')).toContain('Orphan')
  })
})

describe('PIN (B6)', () => {
  it.fails('offers no PIN when creating a vault', async () => {
    render(createElement(StillHome))
    await screen.findByPlaceholderText('Create a strong password')

    expect(screen.queryByRole('button', { name: 'Add PIN' })).toBeNull()
  })

  it.fails('offers no PIN on the unlock screen, even for vaults saved with the PIN flag', async () => {
    seedVault({ lenses: [{ id: 'l1', name: 'Alpha' }], hasPin: true })
    render(createElement(StillHome))
    await screen.findByPlaceholderText('Enter your password')

    expect(screen.queryByRole('button', { name: 'Use PIN instead' })).toBeNull()
  })
})
