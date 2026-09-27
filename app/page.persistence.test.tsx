// @vitest-environment happy-dom
//
// Persistence tests for app/page.tsx: they drive the real UI and check what
// ends up in localStorage. Crypto is replaced by a fast, readable fake;
// crypto.golden.test.ts and crypto.vectors.test.ts cover the real thing.
//
// `it.fails` marks known bugs from AUDIT.md (B1, B2, B4). The test body says
// what should happen; it fails today. When a fix lands, change `it.fails` to
// `it` in the same commit. Each `it.fails` has a passing sibling that runs the
// same steps, so a broken step can't make a known-bug test "pass" by accident.

import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { createElement } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('next/image', () => ({
  default: ({ src, alt }: { src: string; alt: string }) => createElement('img', { src, alt }),
}))

// Fake crypto. Blobs are readable strings that name their key, so a blob
// wrapped with the wrong key fails to open, like the real AEAD.
vi.mock('./lib/crypto', () => {
  const hex = (data: Uint8Array) => Buffer.from(data).toString('hex')
  const unhex = (value: string) => new Uint8Array(Buffer.from(value, 'hex'))
  return {
    generateMasterKey: async () => crypto.getRandomValues(new Uint8Array(32)),
    encryptMasterKey: async (key: Uint8Array, password: string) => ({
      encryptedMasterKey: `MK|${password}|${hex(key)}`,
      salt: 'SALT',
    }),
    decryptMasterKey: async (blob: string, password: string) => {
      const [tag, pw, key] = blob.split('|')
      if (tag !== 'MK' || pw !== password) throw new Error('wrong password')
      return unhex(key)
    },
    encryptLensMasterKey: async (lensKey: Uint8Array, appKey: Uint8Array) => `LK|${hex(appKey)}|${hex(lensKey)}`,
    decryptLensMasterKey: async (blob: string, appKey: Uint8Array) => {
      const [tag, wrappedWith, lensKey] = blob.split('|')
      if (tag !== 'LK' || wrappedWith !== hex(appKey)) throw new Error('cannot unwrap lens key')
      return unhex(lensKey)
    },
    encrypt: async (plaintext: string, key: Uint8Array) => `V|${hex(key)}|${plaintext}`,
    decrypt: async (blob: string, key: Uint8Array) => {
      const [tag, encryptedWith, ...rest] = blob.split('|')
      if (tag !== 'V' || encryptedWith !== hex(key)) throw new Error('cannot decrypt')
      return rest.join('|')
    },
  }
})

import StillHome from './page'

// ---- fixtures ---------------------------------------------------------------

const PASSWORD = 'test-password-1'
const APP_KEY = 'a1'.repeat(32)
const OTHER_APP_KEY = 'b2'.repeat(32)
const DAY = 24 * 60 * 60 * 1000

type SeedLens = { id: string; name: string; deletedAt?: string; wrappedWith?: string }

function persisted({ id, name, deletedAt, wrappedWith = APP_KEY }: SeedLens) {
  const lensKey = id.padEnd(64, '0').slice(0, 64).replace(/[^0-9a-f]/g, 'c')
  return {
    id,
    name,
    createdAt: '2026-01-01T00:00:00.000Z',
    itemCount: 1,
    encryptedMasterKey: `LK|${wrappedWith}|${lensKey}`,
    items: [{ id: `${id}-item`, label: `${name} secret`, type: 'password', encryptedValue: `V|${lensKey}|value-of-${id}` }],
    ...(deletedAt ? { deletedAt } : {}),
  }
}

function seedVault({ lenses = [], bin = [] }: { lenses?: SeedLens[]; bin?: SeedLens[] }) {
  localStorage.setItem('still-encrypted-master-key', `MK|${PASSWORD}|${APP_KEY}`)
  localStorage.setItem('still-salt', 'SALT')
  localStorage.setItem('still-has-pin', 'false')
  localStorage.setItem('still-lenses', JSON.stringify(lenses.map(persisted)))
  localStorage.setItem('still-recycle-bin', JSON.stringify(bin.map(persisted)))
}

const stored = (key: 'still-lenses' | 'still-recycle-bin'): { id: string; name: string }[] =>
  JSON.parse(localStorage.getItem(key) ?? 'null')
const storedNames = (key: 'still-lenses' | 'still-recycle-bin') => (stored(key) ?? []).map((lens) => lens.name)

// ---- UI steps ---------------------------------------------------------------

async function unlock() {
  render(createElement(StillHome))
  fireEvent.change(await screen.findByPlaceholderText('Enter your password'), { target: { value: PASSWORD } })
  fireEvent.click(screen.getByRole('button', { name: 'Unlock' }))
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
    expect(localStorage.getItem('still-encrypted-master-key')).toMatch(/^MK\|new-password-1\|/)
  })

  it.fails('does not destroy existing Lenses when the master key is missing', async () => {
    localStorage.setItem('still-lenses', JSON.stringify([persisted({ id: 'o1', name: 'Orphan' })]))
    await createVault('new-password-1')
    await createLens('Fresh')

    await waitFor(() => expect(storedNames('still-lenses')).toContain('Fresh'))
    expect(storedNames('still-lenses')).toContain('Orphan')
  })
})
