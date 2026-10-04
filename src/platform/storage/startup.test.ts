import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { fakeWebStorage } from '@/test/fakeWebStorage'
import { VaultFileError, type FileLoad, type StoredValues, type VaultFileApi } from '@/platform/tauri/vaultFile'
import { MOVED_MARKER, fingerprint, moveOldCopy, openVaultStorage } from './startup'

const NOW = () => new Date('2026-10-05T10:00:00.000Z')

/** The five localStorage values of the vault exported from a release build. */
const realVault: StoredValues = JSON.parse(readFileSync(new URL('../../../fixtures/vault-v1-real/vault.json', import.meta.url), 'utf8'))

/** A vault file in memory, behaving like store.rs. */
class FakeFile implements VaultFileApi {
  values: StoredValues | null = null
  status: FileLoad['status'] | null = null
  failImport = false
  failWrite = false
  imports: StoredValues[] = []

  async load(): Promise<FileLoad> {
    if (this.status && this.status !== 'values') return { status: this.status } as FileLoad
    return this.values ? { status: 'values', values: { ...this.values } } : { status: 'nothing' }
  }
  async write(changes: Record<string, string | null>) {
    if (this.failWrite) throw new VaultFileError('failed')
    const next = { ...(this.values ?? {}) }
    for (const [k, v] of Object.entries(changes)) {
      if (v === null) delete next[k]
      else next[k] = v
    }
    this.values = next
  }
  async importLegacy(values: StoredValues) {
    if (this.values) throw new VaultFileError('exists')
    if (this.failImport) throw new VaultFileError('failed')
    this.imports.push(values)
    this.values = { ...values }
  }
}

describe('opening the vault storage at start-up', () => {
  it('starts a new install with an empty file storage, writing nothing yet', async () => {
    const file = new FakeFile()
    const legacy = fakeWebStorage({ 'unrelated-app-key': 'x' })
    const started = await openVaultStorage(file, legacy, NOW)
    expect(started.kind).toBe('ready')
    expect(file.values).toBeNull()
    expect(legacy.getItem(MOVED_MARKER)).toBeNull()
  })

  it('moves the old vault into the file once, unchanged, and keeps the old copy', async () => {
    const file = new FakeFile()
    const setAside = { 'still-set-aside-2026-09-01T00:00:00.000Z-still-salt': 'old-salt' }
    const legacy = fakeWebStorage({ ...realVault, ...setAside, 'unrelated-app-key': 'x' })
    const started = await openVaultStorage(file, legacy, NOW)

    expect(started).toMatchObject({ kind: 'ready', notice: 'moved' })
    expect(file.imports).toEqual([{ ...realVault, ...setAside }])
    if (started.kind !== 'ready') throw new Error('ready')
    expect(started.storage.get('still-lenses')).toBe(realVault['still-lenses'])
    // The old copy is untouched, apart from the marker.
    for (const [key, value] of Object.entries(realVault)) expect(legacy.getItem(key)).toBe(value)
    expect(JSON.parse(legacy.getItem(MOVED_MARKER)!)).toEqual({
      movedAt: NOW().toISOString(),
      fingerprint: await fingerprint({ ...realVault, ...setAside }),
    })

    // The next start uses the file, with no notice.
    const again = await openVaultStorage(file, legacy, NOW)
    expect(again.kind).toBe('ready')
    expect('notice' in again && again.notice).toBeFalsy()
    expect(file.imports).toHaveLength(1)
  })

  it('uses the file, not the old copy, from then on', async () => {
    const file = new FakeFile()
    const legacy = fakeWebStorage({ ...realVault })
    await openVaultStorage(file, legacy, NOW)
    file.values!['still-lenses'] = '[]'
    const started = await openVaultStorage(file, legacy, NOW)
    if (started.kind !== 'ready') throw new Error('ready')
    expect(started.storage.get('still-lenses')).toBe('[]')
  })

  it('says once when an older version changed the old copy after the move', async () => {
    const file = new FakeFile()
    const legacy = fakeWebStorage({ ...realVault })
    await openVaultStorage(file, legacy, NOW)
    legacy.setItem('still-lenses', '[]')

    expect(await openVaultStorage(file, legacy, NOW)).toMatchObject({ kind: 'ready', notice: 'old-copy-changed' })
    const again = await openVaultStorage(file, legacy, NOW)
    expect('notice' in again && again.notice).toBeFalsy()
    expect(file.values!['still-lenses']).toBe(realVault['still-lenses'])
  })

  it('never quietly brings back the old copy when the moved file has gone', async () => {
    const file = new FakeFile()
    const legacy = fakeWebStorage({ ...realVault })
    await openVaultStorage(file, legacy, NOW)
    file.values = null

    expect(await openVaultStorage(file, legacy, NOW)).toEqual({ kind: 'file-missing', movedAt: NOW().toISOString() })
    expect(file.values).toBeNull()
    // Only when the user chooses to.
    expect(await moveOldCopy(file, legacy, undefined, NOW)).toMatchObject({ kind: 'ready', notice: 'moved' })
    expect(file.values).toEqual(realVault)
  })

  it('reports a damaged file, another open copy, and a failed move', async () => {
    const legacy = fakeWebStorage({ ...realVault })
    const file = new FakeFile()
    file.status = 'unreadable'
    expect(await openVaultStorage(file, legacy, NOW)).toEqual({ kind: 'unreadable' })
    file.status = 'already-open'
    expect(await openVaultStorage(file, legacy, NOW)).toEqual({ kind: 'already-open' })

    const failing = new FakeFile()
    failing.failImport = true
    expect(await openVaultStorage(failing, legacy, NOW)).toEqual({ kind: 'failed' })
    // No marker, so the move is tried again next time.
    expect(legacy.getItem(MOVED_MARKER)).toBeNull()
  })

  it('writes through the file first, and changes nothing when the file refuses', async () => {
    const file = new FakeFile()
    const started = await openVaultStorage(file, fakeWebStorage(), NOW)
    if (started.kind !== 'ready') throw new Error('ready')
    await started.storage.write({ a: '1' })
    expect(file.values).toEqual({ a: '1' })
    file.failWrite = true
    await expect(started.storage.write({ a: '2', b: '3' })).rejects.toThrow()
    expect(started.storage.get('a')).toBe('1')
    expect(started.storage.get('b')).toBeNull()
  })
})
