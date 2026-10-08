// Records what the vault backend does today, step by step, in a form any
// implementation can replay: fixtures/vault-behaviour-v1/scenarios.json.
// The Rust backend replays the same file, so the two can't drift apart.
//
// Normally this test runs every scenario and checks the result against the
// committed file. To write the file the first time, run it with
// STILL_RECORD_BEHAVIOUR=1; that refuses to overwrite an existing file
// (never regenerate a fixture to make a test pass).
//
// Each scenario is a list of steps. A step is plain JSON: an operation, its
// arguments, and what was seen after it ran (`expect`). Lens and item ids
// that the backend generates, and every encrypted blob, differ from run to
// run and between implementations, so they are recorded as placeholders
// (`<id-N>`, `<blob-N>`), numbered in order of first appearance. The fixture
// documents the exact rules.

import { readFileSync, writeFileSync } from 'node:fs'
import { randomBytes } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import * as fakeCrypto from '@/test/fakeCrypto'
import { MemoryStorage } from '@/test/memoryStorage'
import { createLibsodiumVaultCrypto } from '@/test/reference/libsodiumVaultCrypto'
import { VaultCryptoError } from '@/platform/crypto/vaultCrypto'
import { VaultDataError } from '@/features/vault/model/model'
import { STORAGE_KEYS, type ItemType } from '@/features/vault/model/types'
import { createVaultBackend, VaultLockedError, VaultWriteError, type VaultBackend } from './backend'

type Json = null | boolean | number | string | Json[] | { [key: string]: Json }
type Step = { op: string } & { [arg: string]: Json }
interface Scenario {
  name: string
  about: string
  /** Steps run concurrently (begin/finish, held writes or crypto); see the fixture's notes. */
  concurrent?: boolean
  /** How the Rust backend differs here, on purpose; it replays every other scenario exactly. */
  rust?: string
  steps: Step[]
}

const FIXTURE = new URL('../../../fixtures/vault-behaviour-v1/scenarios.json', import.meta.url)
const START = '2026-10-08T12:00:00.000Z'
const PASSWORD = 'pw-behaviour-1'

// A v1-shaped Lens key blob that no key opens (version 1, zero nonce, 0x09 key bytes, 0x07 tag).
const UNOPENABLE_KEY = 'AQAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAkJCQkJCQkJCQkJCQkJCQkJCQkJCQkJCQkJCQkJCQkJBwcHBwcHBwcHBwcHBwcHBw=='

// ---- the scenarios ----------------------------------------------------------

const create: Step = { op: 'create', password: PASSWORD }
const unlock: Step = { op: 'unlock', password: PASSWORD }
const restart: Step[] = [{ op: 'lock' }, { op: 'reopen' }, unlock]

const SCENARIOS: Scenario[] = [
  {
    name: 'create-unlock-lock',
    about: 'Status through create, lock and unlock; a wrong password; create refused over an existing vault.',
    steps: [
      { op: 'status' },
      { op: 'unlock', password: PASSWORD },
      create,
      { op: 'lock' },
      { op: 'unlock', password: 'wrong password' },
      unlock,
      { op: 'unlock', password: 'wrong while unlocked' },
      unlock,
      { op: 'lock' },
      { op: 'create', password: 'while locked' },
      { op: 'reopen' },
      { op: 'unlock', password: '' },
      unlock,
      { op: 'create', password: 'another' },
    ],
  },
  {
    name: 'locked',
    about: 'While locked, every change, reveal and copy is refused and storage is left alone.',
    steps: [
      create,
      { op: 'createLens', name: 'A', as: 'A' },
      { op: 'addItem', lens: '$A', label: 'L', type: 'password', value: 'v', as: 'a1' },
      { op: 'createLens', name: 'B', as: 'B' },
      { op: 'forgetLens', lens: '$B' },
      { op: 'lock' },
      { op: 'createLens', name: 'C' },
      { op: 'addItem', lens: '$A', label: 'M', type: 'note', value: 'w' },
      { op: 'updateItem', lens: '$A', item: '$a1', label: 'X', type: 'key', value: 'w' },
      { op: 'updateItem', lens: '$A', item: '$a1', label: 'X', type: 'key' },
      { op: 'deleteItem', lens: '$A', item: '$a1' },
      { op: 'renameLens', lens: '$A', name: 'X' },
      { op: 'revealItem', lens: '$A', item: '$a1' },
      { op: 'copyItem', lens: '$A', item: '$a1' },
      { op: 'forgetLens', lens: '$A' },
      { op: 'restoreLens', lens: '$B' },
      { op: 'deleteLensForever', lens: '$B' },
      { op: 'lock' },
      unlock,
      { op: 'revealItem', lens: '$A', item: '$a1' },
    ],
  },
  {
    name: 'lenses-and-items',
    about: 'Create Lenses and secrets, reveal, copy, edit, delete and rename, then reopen and reveal again.',
    steps: [
      create,
      { op: 'createLens', name: 'Work', as: 'W' },
      { op: 'createLens', name: '  Home  ', as: 'H' },
      { op: 'addItem', lens: '$W', label: 'Email', type: 'password', value: ' pass with spaces ', as: 'w1' },
      { op: 'addItem', lens: '$W', label: 'Deploy token', type: 'key', value: 'stl_live_4f9a2c81e07b3d56', as: 'w2' },
      { op: 'addItem', lens: '$W', label: 'Recovery 📝', type: 'note', value: 'line one\nline two\n\ttabbed\n', as: 'w3' },
      { op: 'addItem', lens: '$H', label: 'Router', type: 'password', value: 'dummy-Pässwörd-🔐-42', as: 'h1' },
      { op: 'addItem', lens: '$H', label: '  Untrimmed label  ', type: 'card', value: 'a type the app never makes', as: 'h2' },
      { op: 'revealItem', lens: '$W', item: '$w1' },
      { op: 'revealItem', lens: '$W', item: '$w3' },
      { op: 'revealItem', lens: '$H', item: '$h1' },
      { op: 'copyItem', lens: '$W', item: '$w2' },
      { op: 'updateItem', lens: '$W', item: '$w1', label: '  Email (work)  ', type: 'key' },
      { op: 'updateItem', lens: '$W', item: '$w2', label: 'Deploy token', type: 'key', value: 'stl_live_rotated' },
      { op: 'revealItem', lens: '$W', item: '$w2' },
      { op: 'deleteItem', lens: '$W', item: '$w3' },
      { op: 'renameLens', lens: '$H', name: '  Personal  ' },
      ...restart,
      { op: 'revealItem', lens: '$W', item: '$w1' },
      { op: 'revealItem', lens: '$W', item: '$w2' },
      { op: 'revealItem', lens: '$H', item: '$h1' },
    ],
  },
  {
    name: 'refusals',
    about: 'Changes that are refused: empty names and labels, unknown Lenses and secrets, whitespace-only values, Lenses in the bin.',
    steps: [
      create,
      { op: 'createLens', name: 'A', as: 'A' },
      { op: 'addItem', lens: '$A', label: 'L', type: 'password', value: 'v', as: 'a1' },
      { op: 'createLens', name: 'B', as: 'B' },
      { op: 'renameLens', lens: '$A', name: '   ' },
      { op: 'renameLens', lens: 'no-such-lens', name: 'X' },
      { op: 'updateItem', lens: '$A', item: '$a1', label: '  ', type: 'password' },
      { op: 'updateItem', lens: '$A', item: 'no-such-item', label: 'X', type: 'password' },
      { op: 'updateItem', lens: 'no-such-lens', item: '$a1', label: 'X', type: 'password' },
      { op: 'addItem', lens: 'no-such-lens', label: 'X', type: 'password', value: 'v' },
      { op: 'addItem', lens: '$A', label: 'Blank', type: 'password', value: ' \n\t ' },
      { op: 'updateItem', lens: '$A', item: '$a1', label: 'L', type: 'password', value: '   ' },
      { op: 'revealItem', lens: '$A', item: 'no-such-item' },
      { op: 'copyItem', lens: 'no-such-lens', item: '$a1' },
      { op: 'deleteItem', lens: 'no-such-lens', item: '$a1' },
      { op: 'deleteItem', lens: '$A', item: 'no-such-item' },
      { op: 'forgetLens', lens: '$B' },
      { op: 'renameLens', lens: '$B', name: 'X' },
      { op: 'addItem', lens: '$B', label: 'X', type: 'note', value: 'v' },
      { op: 'forgetLens', lens: '$A' },
      { op: 'updateItem', lens: '$A', item: '$a1', label: 'X', type: 'password' },
      { op: 'deleteItem', lens: '$A', item: '$a1' },
      { op: 'renameLens', lens: '$A', name: '' },
      { op: 'restoreLens', lens: '$A' },
      { op: 'forgetLens', lens: 'no-such-lens' },
      { op: 'restoreLens', lens: 'no-such-lens' },
      { op: 'deleteLensForever', lens: 'no-such-lens' },
      { op: 'createLens', name: '', as: 'E' },
    ],
  },
  {
    name: 'archive',
    about: 'Forget, restore and delete for good; revealing and copying from a forgotten Lens; emptying both lists.',
    steps: [
      create,
      { op: 'createLens', name: 'A', as: 'A' },
      { op: 'addItem', lens: '$A', label: 'Secret', type: 'password', value: 'in A', as: 'a1' },
      { op: 'createLens', name: 'B', as: 'B' },
      { op: 'clock', now: '2026-10-08T13:00:00.000Z' },
      { op: 'forgetLens', lens: '$A' },
      { op: 'revealItem', lens: '$A', item: '$a1' },
      { op: 'copyItem', lens: '$A', item: '$a1' },
      { op: 'clock', now: '2026-10-08T14:00:00.000Z' },
      { op: 'forgetLens', lens: '$B' },
      { op: 'restoreLens', lens: '$A' },
      { op: 'deleteLensForever', lens: '$B' },
      { op: 'forgetLens', lens: '$A' },
      { op: 'deleteLensForever', lens: '$A' },
      ...restart,
    ],
  },
  {
    name: 'purge',
    about: 'Archive entries older than 7 days are purged on unlock, and that is saved; the exact boundary; odd or missing deletedAt.',
    steps: [
      create,
      { op: 'createLens', name: 'Keep', as: 'K' },
      { op: 'addItem', lens: '$K', label: 'Kept', type: 'password', value: 'kept', as: 'k1' },
      { op: 'createLens', name: 'Old', as: 'O' },
      { op: 'createLens', name: 'Edge', as: 'E' },
      { op: 'createLens', name: 'Fresh', as: 'F' },
      { op: 'clock', now: '2026-10-01T12:00:00.000Z' },
      { op: 'forgetLens', lens: '$O' },
      { op: 'clock', now: '2026-10-01T12:00:00.001Z' },
      { op: 'forgetLens', lens: '$E' },
      { op: 'clock', now: '2026-10-07T12:00:00.000Z' },
      { op: 'forgetLens', lens: '$F' },
      { op: 'clock', now: START },
      ...restart,
      { op: 'clock', now: '2026-10-08T12:00:00.001Z' },
      ...restart,
      { op: 'lock' },
      {
        op: 'setStored',
        key: STORAGE_KEYS.bin,
        value: JSON.stringify([
          { id: 'no-date', name: 'No date', createdAt: START, itemCount: 0, encryptedMasterKey: '$K.key', items: [] },
          { id: 'bad-date', name: 'Bad date', createdAt: START, itemCount: 0, encryptedMasterKey: '$K.key', items: [], deletedAt: 'yesterday' },
          { id: 'null-date', name: 'Null date', createdAt: START, itemCount: 0, encryptedMasterKey: '$K.key', items: [], deletedAt: null },
          { id: 'day-only', name: 'Day only', createdAt: START, itemCount: 0, encryptedMasterKey: '$K.key', items: [], deletedAt: '2026-10-07' },
          { id: 'no-millis', name: 'No millis', createdAt: START, itemCount: 0, encryptedMasterKey: '$K.key', items: [], deletedAt: '2026-10-07T12:00:00Z' },
          { id: 'offset', name: 'Offset', createdAt: START, itemCount: 0, encryptedMasterKey: '$K.key', items: [], deletedAt: '2026-10-07T14:00:00.000+02:00' },
          { id: 'old-offset', name: 'Old offset', createdAt: START, itemCount: 0, encryptedMasterKey: '$K.key', items: [], deletedAt: '2026-10-01T13:00:00.000+02:00' },
          { id: 'future', name: 'Future', createdAt: START, itemCount: 0, encryptedMasterKey: '$K.key', items: [], deletedAt: '2027-01-01T00:00:00.000Z' },
          { id: 'old-unreadable', name: 'Old unreadable', createdAt: START, itemCount: 0, encryptedMasterKey: UNOPENABLE_KEY, items: [], deletedAt: '2026-09-01T00:00:00.000Z' },
          { id: 'new-unreadable', name: 'New unreadable', createdAt: START, itemCount: 0, encryptedMasterKey: UNOPENABLE_KEY, items: [], deletedAt: '2026-10-07T00:00:00.000Z' },
        ]),
      },
      { op: 'reopen' },
      unlock,
      { op: 'lock' },
      {
        op: 'setStored',
        key: STORAGE_KEYS.bin,
        value: JSON.stringify([
          { id: 'expired', name: 'Expired', createdAt: START, itemCount: 0, encryptedMasterKey: '$K.key', items: [], deletedAt: '2026-09-01T00:00:00.000Z' },
        ]),
      },
      { op: 'reopen' },
      { op: 'failWrites', keys: 'all' },
      unlock,
      { op: 'failWrites', keys: [] },
      { op: 'createLens', name: 'After a failed purge', as: 'N' },
      ...restart,
    ],
  },
  {
    name: 'failed-writes',
    about: 'A failed write changes nothing, in storage or in the view, for every kind of change; create and set-aside too.',
    steps: [
      { op: 'failWrites', keys: 'all' },
      create,
      { op: 'failWrites', keys: [] },
      create,
      { op: 'createLens', name: 'A', as: 'A' },
      { op: 'addItem', lens: '$A', label: 'L', type: 'password', value: 'v', as: 'a1' },
      { op: 'failWrites', keys: 'all' },
      { op: 'createLens', name: 'B' },
      { op: 'addItem', lens: '$A', label: 'M', type: 'note', value: 'w' },
      { op: 'updateItem', lens: '$A', item: '$a1', label: 'X', type: 'key', value: 'changed' },
      { op: 'updateItem', lens: '$A', item: '$a1', label: 'X', type: 'key' },
      { op: 'deleteItem', lens: '$A', item: '$a1' },
      { op: 'renameLens', lens: '$A', name: 'Renamed' },
      { op: 'forgetLens', lens: '$A' },
      { op: 'revealItem', lens: '$A', item: '$a1' },
      { op: 'failWrites', keys: [STORAGE_KEYS.lenses] },
      { op: 'forgetLens', lens: '$A' },
      { op: 'failWrites', keys: [STORAGE_KEYS.bin] },
      { op: 'forgetLens', lens: '$A' },
      { op: 'failWrites', keys: [] },
      { op: 'forgetLens', lens: '$A' },
      { op: 'failWrites', keys: [STORAGE_KEYS.lenses] },
      { op: 'restoreLens', lens: '$A' },
      { op: 'deleteLensForever', lens: '$A' },
      { op: 'failWrites', keys: [] },
      { op: 'restoreLens', lens: '$A' },
      { op: 'lock' },
      { op: 'failWrites', keys: 'all' },
      { op: 'setAside' },
      { op: 'failWrites', keys: [] },
      { op: 'reopen' },
      unlock,
      { op: 'revealItem', lens: '$A', item: '$a1' },
    ],
  },
  {
    name: 'unreadable-lenses',
    about: 'A Lens whose key does not open is kept byte for byte, hidden and counted, through other changes and restarts.',
    steps: [
      create,
      { op: 'createLens', name: 'Good', as: 'G' },
      { op: 'addItem', lens: '$G', label: 'L', type: 'password', value: 'good', as: 'g1' },
      { op: 'lock' },
      {
        op: 'setStored',
        key: STORAGE_KEYS.lenses,
        value:
          '[{"id":"$G","name":"Good","createdAt":"2026-10-08T12:00:00.000Z","itemCount":1,"encryptedMasterKey":"$G.key","items":[{"id":"$g1","label":"L","type":"password","encryptedValue":"$g1.value"}]},' +
          `{"name":"Broken","id":"broken","itemCount":1,"encryptedMasterKey":"${UNOPENABLE_KEY}","createdAt":"2026-01-01T00:00:00.000Z","items":[{"id":"i","label":"x","type":"password","encryptedValue":"opaque","extra":[1,{"deep":null}]}],"colour":"blue"},` +
          `{"id":"no-items","name":"No items","createdAt":"2026-01-02T00:00:00.000Z","itemCount":0,"encryptedMasterKey":"${UNOPENABLE_KEY}"}]`,
      },
      {
        op: 'setStored',
        key: STORAGE_KEYS.bin,
        value: `[{"id":"binned","name":"Binned","createdAt":"2026-01-03T00:00:00.000Z","itemCount":0,"encryptedMasterKey":"not base64!","items":[],"deletedAt":"2026-10-07T00:00:00.000Z"}]`,
      },
      { op: 'reopen' },
      unlock,
      { op: 'createLens', name: 'New', as: 'N' },
      { op: 'forgetLens', lens: '$G' },
      { op: 'restoreLens', lens: '$G' },
      { op: 'revealItem', lens: '$G', item: '$g1' },
      { op: 'revealItem', lens: 'broken', item: 'i' },
      { op: 'copyItem', lens: 'broken', item: 'i' },
      { op: 'addItem', lens: 'broken', label: 'X', type: 'note', value: 'v' },
      { op: 'updateItem', lens: 'broken', item: 'i', label: 'X', type: 'note', value: 'v' },
      { op: 'updateItem', lens: 'broken', item: 'i', label: 'Relabelled', type: 'note' },
      { op: 'renameLens', lens: 'broken', name: 'Renamed' },
      { op: 'forgetLens', lens: 'no-items' },
      { op: 'deleteLensForever', lens: 'binned' },
      ...restart,
    ],
  },
  {
    name: 'readable-lens-shapes',
    about: 'Readable Lenses with unknown fields, unusual key order or no items field: what is kept and how it is written back.',
    steps: [
      create,
      { op: 'createLens', name: 'Seed', as: 'S' },
      { op: 'addItem', lens: '$S', label: 'L', type: 'password', value: 'seed value', as: 's1' },
      { op: 'lock' },
      {
        op: 'setStored',
        key: STORAGE_KEYS.lenses,
        value:
          '[{"encryptedMasterKey":"$S.key","items":[{"type":"password","encryptedValue":"$s1.value","label":"L","id":"$s1","note":"kept"},{"id":"damaged","label":"Damaged","type":"note","encryptedValue":"AQAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA="},{"id":"not-base64","label":"Not base64","type":"note","encryptedValue":"%%%"}],"id":"$S","name":"Seed","itemCount":1,"createdAt":"2026-10-08T12:00:00.000Z","colour":"blue","nested":{"a":[1,2.5,-3,true,false,null,"x"]}},' +
          '{"id":"bare","name":"Bare","createdAt":"2026-01-01T00:00:00.000Z","itemCount":0,"encryptedMasterKey":"$S.key"},' +
          '{"id":"stale-count","name":"Stale count","createdAt":"2026-01-01T00:00:00.000Z","itemCount":7,"encryptedMasterKey":"$S.key","items":[]}]',
      },
      { op: 'reopen' },
      unlock,
      { op: 'addItem', lens: 'bare', label: 'First', type: 'note', value: 'into a Lens with no items field', as: 'b1' },
      { op: 'renameLens', lens: 'stale-count', name: 'Stale count, renamed' },
      { op: 'updateItem', lens: '$S', item: '$s1', label: 'L2', type: 'note' },
      { op: 'forgetLens', lens: '$S' },
      { op: 'restoreLens', lens: '$S' },
      ...restart,
      { op: 'revealItem', lens: 'bare', item: '$b1' },
      { op: 'revealItem', lens: '$S', item: 'damaged' },
      { op: 'copyItem', lens: '$S', item: 'damaged' },
      { op: 'revealItem', lens: '$S', item: 'not-base64' },
    ],
  },
  {
    name: 'older-versions',
    about: 'Data left by v0.1.0: short ids, and the same Lens in both lists. Restoring keeps the Archive copy; forgetting replaces it.',
    steps: [
      create,
      { op: 'createLens', name: 'Seed', as: 'S' },
      { op: 'addItem', lens: '$S', label: 'Old item', type: 'password', value: 'old value', as: 's1' },
      { op: 'addItem', lens: '$S', label: 'Newer item', type: 'password', value: 'newer value', as: 's2' },
      { op: 'lock' },
      {
        op: 'setStored',
        key: STORAGE_KEYS.bin,
        value:
          '[{"id":"mfz1abc","name":"Twice","createdAt":"2025-06-01T10:00:00.000Z","itemCount":2,"encryptedMasterKey":"$S.key","items":[{"id":"mfz1abd","label":"Old item","type":"password","encryptedValue":"$s1.value"},{"id":"mfz1abe","label":"Newer item","type":"password","encryptedValue":"$s2.value"}],"deletedAt":"2026-10-07T10:00:00.000Z"},' +
          '{"id":"mfz3def","name":"Twice too, older here","createdAt":"2025-06-03T10:00:00.000Z","itemCount":0,"encryptedMasterKey":"$S.key","items":[],"deletedAt":"2026-10-06T10:00:00.000Z"}]',
      },
      {
        op: 'setStored',
        key: STORAGE_KEYS.lenses,
        value:
          '[{"id":"mfz1abc","name":"Twice","createdAt":"2025-06-01T10:00:00.000Z","itemCount":1,"encryptedMasterKey":"$S.key","items":[{"id":"mfz1abd","label":"Old item","type":"password","encryptedValue":"$s1.value"}]},' +
          '{"id":"mfz2xyz","name":"Once","createdAt":"2025-06-02T10:00:00.000Z","itemCount":0,"encryptedMasterKey":"$S.key","items":[]},' +
          '{"id":"mfz3def","name":"Twice too, newer here","createdAt":"2025-06-03T10:00:00.000Z","itemCount":0,"encryptedMasterKey":"$S.key","items":[]}]',
      },
      { op: 'reopen' },
      unlock,
      { op: 'revealItem', lens: 'mfz1abc', item: 'mfz1abe' },
      { op: 'addItem', lens: 'mfz2xyz', label: 'New in old', type: 'key', value: 'k', as: 'o1' },
      { op: 'forgetLens', lens: 'mfz3def' },
      { op: 'restoreLens', lens: 'mfz1abc' },
      { op: 'forgetLens', lens: 'mfz1abc' },
      { op: 'restoreLens', lens: 'mfz1abc' },
      ...restart,
    ],
  },
  {
    name: 'unreadable-lists',
    about: 'A stored list that is not a JSON list blocks unlocking and writes nothing; lists with odd entries or spacing.',
    steps: [
      create,
      { op: 'createLens', name: 'A', as: 'A' },
      { op: 'lock' },
      { op: 'setStored', key: STORAGE_KEYS.bin, value: '{oops' },
      unlock,
      { op: 'setStored', key: STORAGE_KEYS.bin, value: '{"id":"x"}' },
      unlock,
      { op: 'setStored', key: STORAGE_KEYS.bin, value: 'null' },
      unlock,
      { op: 'setStored', key: STORAGE_KEYS.bin, value: '' },
      unlock,
      { op: 'setStored', key: STORAGE_KEYS.bin, value: '[1]' },
      unlock,
      { op: 'lock' },
      { op: 'setStored', key: STORAGE_KEYS.bin, value: '[null]' },
      unlock,
      { op: 'setStored', key: STORAGE_KEYS.bin, value: ' [ ]\n' },
      unlock,
      { op: 'createLens', name: 'B', as: 'B' },
      { op: 'lock' },
      { op: 'setStored', key: STORAGE_KEYS.bin, value: null },
      { op: 'reopen' },
      unlock,
      { op: 'forgetLens', lens: '$A' },
      { op: 'lock' },
      { op: 'setStored', key: STORAGE_KEYS.lenses, value: '[\n  {"id": "spaced", "name": "Spaced",\n   "createdAt": "2026-01-01T00:00:00.000Z", "itemCount": 0, "encryptedMasterKey": "$A.key", "items": []}\n]' },
      { op: 'reopen' },
      unlock,
      { op: 'renameLens', lens: 'spaced', name: 'Compact' },
    ],
  },
  {
    name: 'damaged-key',
    about: 'A master key or salt with the wrong shape is unreadable data, reported before any password check.',
    steps: [
      create,
      { op: 'lock' },
      { op: 'setStored', key: STORAGE_KEYS.salt, value: 'AAAA' },
      unlock,
      { op: 'setStored', key: STORAGE_KEYS.salt, value: 'AAAAAAAAAAAAAAAAAAAAAA==' },
      { op: 'setStored', key: STORAGE_KEYS.masterKey, value: 'not base64' },
      unlock,
      { op: 'setStored', key: STORAGE_KEYS.masterKey, value: UNOPENABLE_KEY.replace(/^AQ/, 'Ag') },
      unlock,
      { op: 'setStored', key: STORAGE_KEYS.masterKey, value: UNOPENABLE_KEY },
      unlock,
    ],
  },
  {
    name: 'orphaned-data',
    about: 'Vault data without its key or salt is orphaned: create is refused, and set-aside moves everything out of the way first.',
    steps: [
      { op: 'setStored', key: STORAGE_KEYS.lenses, value: '[]' },
      { op: 'setStored', key: STORAGE_KEYS.bin, value: '[]' },
      { op: 'status' },
      { op: 'setStored', key: STORAGE_KEYS.lenses, value: ' [] ' },
      { op: 'status' },
      { op: 'setStored', key: STORAGE_KEYS.lenses, value: '[ ]' },
      { op: 'status' },
      { op: 'setStored', key: STORAGE_KEYS.lenses, value: '[]' },
      { op: 'setStored', key: STORAGE_KEYS.bin, value: '{broken' },
      { op: 'status' },
      { op: 'setStored', key: STORAGE_KEYS.bin, value: null },
      { op: 'setStored', key: STORAGE_KEYS.masterKey, value: 'k' },
      { op: 'status' },
      { op: 'setStored', key: STORAGE_KEYS.masterKey, value: null },
      { op: 'setStored', key: STORAGE_KEYS.salt, value: 'AAAAAAAAAAAAAAAAAAAAAA==' },
      { op: 'status' },
      { op: 'setStored', key: STORAGE_KEYS.salt, value: null },
      {
        op: 'setStored',
        key: STORAGE_KEYS.lenses,
        value: `[{"id":"o","name":"Orphan","createdAt":"","itemCount":0,"encryptedMasterKey":"${UNOPENABLE_KEY}","items":[]}]`,
      },
      { op: 'setStored', key: STORAGE_KEYS.hasPin, value: 'true' },
      { op: 'status' },
      unlock,
      create,
      { op: 'clock', now: '2026-10-08T12:30:00.000Z' },
      { op: 'setAside' },
      create,
      { op: 'createLens', name: 'Fresh', as: 'F' },
      { op: 'clock', now: '2026-10-08T12:31:00.000Z' },
      { op: 'setAside' },
      { op: 'status' },
      { op: 'lock' },
      { op: 'status' },
    ],
  },
  {
    name: 'set-aside',
    about: 'Set-aside copies only the vault\'s own values, writes nothing when there are none, and works on a locked vault.',
    steps: [
      { op: 'setStored', key: 'unrelated-key', value: 'left alone' },
      { op: 'setStored', key: 'still-moved-to-file', value: 'left alone too' },
      { op: 'setAside' },
      create,
      { op: 'createLens', name: 'A', as: 'A' },
      { op: 'lock' },
      { op: 'setAside' },
      { op: 'status' },
      unlock,
      create,
    ],
  },
  {
    name: 'json-text',
    about: 'Names, labels and values with quotes, backslashes, control characters, line separators and emoji, stored and read back exactly.',
    steps: [
      create,
      { op: 'createLens', name: 'Quote " backslash \\ slash / tab \t', as: 'A' },
      { op: 'addItem', lens: '$A', label: 'Ctrl \u0001\u001f\u007f del', type: 'password', value: '\u0000nul\u0008bs\u000cff\r\n', as: 'a1' },
      { op: 'addItem', lens: '$A', label: 'Separators    ', type: 'note', value: 'é é 👩‍👩‍👧 ﻿', as: 'a2' },
      { op: 'addItem', lens: '$A', label: '日本語のラベル', type: 'key', value: '<script>alert(1)</script> & </textarea>', as: 'a3' },
      { op: 'revealItem', lens: '$A', item: '$a1' },
      { op: 'revealItem', lens: '$A', item: '$a2' },
      { op: 'revealItem', lens: '$A', item: '$a3' },
      { op: 'renameLens', lens: '$A', name: '  non-breaking edges  ' },
      { op: 'renameLens', lens: '$A', name: '　ideographic　' },
      ...restart,
      { op: 'revealItem', lens: '$A', item: '$a1' },
    ],
  },
  {
    name: 'lone-surrogate',
    about: 'A stored name with a lone UTF-16 surrogate (only JavaScript can write one). Today it opens and is written back as an escape.',
    rust: 'The list cannot be read back exactly, so unlocking stops with unreadable-data and nothing is written.',
    steps: [
      create,
      { op: 'createLens', name: 'Seed', as: 'S' },
      { op: 'lock' },
      {
        op: 'setStored',
        key: STORAGE_KEYS.lenses,
        value: '[{"id":"lone","name":"half \\ud83d pair","createdAt":"2026-01-01T00:00:00.000Z","itemCount":0,"encryptedMasterKey":"$S.key","items":[]}]',
      },
      { op: 'reopen' },
      unlock,
      { op: 'createLens', name: 'After', as: 'N' },
    ],
  },
  {
    name: 'lock-during-changes',
    about: 'Lock while a change waits on the crypto or on the disk; changes queued together all land, in order.',
    concurrent: true,
    rust: 'Lock waits for a change already under way, then locks: that change is saved. Rust tests this itself instead of replaying it.',
    steps: [
      create,
      { op: 'createLens', name: 'A', as: 'A' },
      { op: 'createLens', name: 'B', as: 'B' },
      { op: 'holdEncrypt' },
      { op: 'begin', as: 'p1', step: { op: 'addItem', lens: '$A', label: 'Waiting on crypto', type: 'password', value: 'v' } },
      { op: 'lock' },
      { op: 'release' },
      { op: 'finish', as: 'p1' },
      unlock,
      { op: 'holdWrites' },
      { op: 'begin', as: 'p2', step: { op: 'forgetLens', lens: '$A' } },
      { op: 'lock' },
      { op: 'release' },
      { op: 'finish', as: 'p2' },
      { op: 'reopen' },
      unlock,
      { op: 'holdWrites' },
      { op: 'begin', as: 'p3', step: { op: 'addItem', lens: '$B', label: 'First', type: 'password', value: '1' } },
      { op: 'begin', as: 'p4', step: { op: 'addItem', lens: '$B', label: 'Second', type: 'password', value: '2' } },
      { op: 'begin', as: 'p5', step: { op: 'renameLens', lens: '$B', name: 'B, renamed' } },
      { op: 'release' },
      { op: 'finish', as: 'p3' },
      { op: 'finish', as: 'p4' },
      { op: 'finish', as: 'p5' },
    ],
  },
]

// ---- the runner ---------------------------------------------------------------

const HEX_ID = /^[0-9a-f]{32}$/
const BLOB = /^[A-Za-z0-9+/]{16,}={0,2}$/
const LIST_KEYS = [STORAGE_KEYS.lenses, STORAGE_KEYS.bin] as const
const BLOB_KEYS = [STORAGE_KEYS.masterKey, STORAGE_KEYS.salt] as const

/** Replaces generated ids and blobs with numbered placeholders, in order of first appearance. */
class Masker {
  private readonly names = new Map<string, string>()
  private ids = 0
  private blobs = 0

  private add(value: unknown, kind: 'id' | 'blob') {
    if (typeof value !== 'string' || value === '' || this.names.has(value)) return
    if (!(kind === 'id' ? HEX_ID : BLOB).test(value)) return
    this.names.set(value, kind === 'id' ? `<id-${++this.ids}>` : `<blob-${++this.blobs}>`)
  }

  /** Learns new ids and blobs from a step's result, then from storage in key order. */
  learn(result: unknown, data: Map<string, string>) {
    if (typeof result === 'string') this.add(result, 'id')
    for (const key of [...data.keys()].sort()) {
      const value = data.get(key)!
      if (BLOB_KEYS.some((k) => key.endsWith(k))) this.add(value, 'blob')
      if (!LIST_KEYS.some((k) => key.endsWith(k))) continue
      let list: unknown
      try {
        list = JSON.parse(value)
      } catch {
        continue
      }
      if (!Array.isArray(list)) continue
      for (const lens of list) {
        if (typeof lens !== 'object' || lens === null) continue
        this.add(lens.id, 'id')
        this.add(lens.encryptedMasterKey, 'blob')
        if (!Array.isArray(lens.items)) continue
        for (const item of lens.items) {
          if (typeof item !== 'object' || item === null) continue
          this.add(item.id, 'id')
          this.add(item.encryptedValue, 'blob')
        }
      }
    }
  }

  /** A whole string that is a known value, or else each known value as a quoted JSON string inside it. */
  mask(text: string): string {
    const whole = this.names.get(text)
    if (whole !== undefined) return whole
    let out = text
    for (const [value, name] of this.names) out = out.split(`"${value}"`).join(`"${name}"`)
    return out
  }

  maskDeep(value: unknown): Json {
    if (typeof value === 'string') return this.mask(value)
    if (Array.isArray(value)) return value.map((v) => this.maskDeep(v))
    if (value !== null && typeof value === 'object') {
      return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, this.maskDeep(v)]))
    }
    return (value ?? null) as Json
  }
}

/** Stable codes for every error the backend throws. Rust uses the same codes. */
function errorCode(error: unknown): string {
  if (error instanceof VaultWriteError) return 'write-failed'
  if (error instanceof VaultLockedError) return 'locked'
  if (error instanceof VaultDataError) return 'vault-exists'
  if (error instanceof VaultCryptoError) return `crypto-${error.code}`
  const message = error instanceof Error ? error.message : String(error)
  const codes: Record<string, string> = {
    'Unknown Lens': 'unknown-lens',
    'Unknown item': 'unknown-item',
    'A secret needs a label': 'empty-label',
    'A Lens needs a name': 'empty-name',
    'Plaintext required': 'empty-value',
    'The disk refused the write': 'storage-failed',
    // The stand-in crypto's errors for a damaged item value; the Rust session reports these as corrupt.
    'ciphertext cannot be decrypted using that key': 'crypto-corrupt',
    'incomplete input': 'crypto-corrupt',
  }
  if (message in codes) return codes[message]
  throw new Error(`No error code for: ${message}`)
}

/** Lets pending promises run until they block on a held gate. */
const settle = async () => {
  for (let i = 0; i < 10; i++) await new Promise((resolve) => setTimeout(resolve, 0))
}

/** Fresh random bytes over a fake blob's nonce, like real encryption: no two blobs repeat. */
function freshNonce(blob: string, start: number): string {
  const bytes = Buffer.from(blob, 'base64')
  randomBytes(24).copy(bytes, start)
  return bytes.toString('base64')
}

async function runScenario(scenario: Scenario) {
  const storage = new MemoryStorage()
  const masker = new Masker()
  const aliases = new Map<string, string>()
  const pending = new Map<string, Promise<Json>>()
  const begun = new Map<string, Step>()
  let now = new Date(START)
  let clipboard: string | null = null
  let encryptGate: Promise<void> | undefined
  const releases: Array<() => void> = []

  const api = {
    ...fakeCrypto,
    encryptMasterKey: async (key: Uint8Array, password: string) => {
      const wrapped = await fakeCrypto.encryptMasterKey(key, password)
      return { ...wrapped, encryptedMasterKey: freshNonce(wrapped.encryptedMasterKey, 1) }
    },
    encryptLensMasterKey: async (key: Uint8Array, appKey: Uint8Array) => freshNonce(await fakeCrypto.encryptLensMasterKey(key, appKey), 1),
    encrypt: async (plaintext: string, key: Uint8Array) => {
      await encryptGate
      return freshNonce(await fakeCrypto.encrypt(plaintext, key), 5)
    },
  }
  const open = () => createVaultBackend(storage, createLibsodiumVaultCrypto(api, (text) => (clipboard = text)), () => now)
  let backend: VaultBackend = open()

  const lists = () => LIST_KEYS.flatMap((key) => {
    try {
      const list = JSON.parse(storage.get(key) ?? '[]')
      return Array.isArray(list) ? list : []
    } catch {
      return []
    }
  })

  /** `$A` is an alias's value; `$A.key` its Lens's stored key, `$a1.value` its item's stored value. */
  function resolve(text: string): string {
    return text.replace(/\$([A-Za-z0-9]+)(\.key|\.value)?/g, (_, alias: string, field?: string) => {
      const id = aliases.get(alias)
      if (id === undefined) throw new Error(`Unknown alias $${alias}`)
      if (!field) return id
      const found =
        field === '.key'
          ? lists().find((l) => l.id === id)?.encryptedMasterKey
          : lists().flatMap((l) => l.items ?? []).find((i: { id: string }) => i.id === id)?.encryptedValue
      if (typeof found !== 'string') throw new Error(`Nothing stored for $${alias}${field}`)
      return found
    })
  }
  const arg = (step: Step, name: string) => resolve(String(step[name]))
  const item = (step: Step) => ({ label: arg(step, 'label'), type: step.type as ItemType })

  /** Runs one backend operation; returns its result, or { error: code }. */
  async function call(step: Step): Promise<Json> {
    try {
      switch (step.op) {
        case 'status':
          return backend.status()
        case 'create':
          await backend.create(String(step.password))
          return null
        case 'unlock':
          return (await backend.unlock(String(step.password))) as Json
        case 'lock':
          await backend.lock()
          return null
        case 'setAside':
          return await backend.setAside()
        case 'createLens': {
          const id = await backend.createLens(arg(step, 'name'))
          if (step.as) aliases.set(String(step.as), id)
          return id
        }
        case 'addItem': {
          const lens = arg(step, 'lens')
          await backend.addItem(lens, { ...item(step), value: String(step.value) })
          // The new secret is the last one in its Lens.
          if (step.as) aliases.set(String(step.as), backend.view().lenses.find((l) => l.id === lens)!.items.at(-1)!.id)
          return null
        }
        case 'updateItem':
          await backend.updateItem(arg(step, 'lens'), arg(step, 'item'), {
            ...item(step),
            ...(step.value === undefined ? {} : { value: String(step.value) }),
          })
          return null
        case 'deleteItem':
          await backend.deleteItem(arg(step, 'lens'), arg(step, 'item'))
          return null
        case 'renameLens':
          await backend.renameLens(arg(step, 'lens'), arg(step, 'name'))
          return null
        case 'revealItem':
          return await backend.revealItem(arg(step, 'lens'), arg(step, 'item'))
        case 'copyItem':
          await backend.copyItem(arg(step, 'lens'), arg(step, 'item'))
          return null
        case 'forgetLens':
          await backend.forgetLens(arg(step, 'lens'))
          return null
        case 'restoreLens':
          await backend.restoreLens(arg(step, 'lens'))
          return null
        case 'deleteLensForever':
          await backend.deleteLensForever(arg(step, 'lens'))
          return null
        default:
          throw new Error(`Unknown operation ${step.op}`)
      }
    } catch (error) {
      return { error: errorCode(error) }
    }
  }

  const recorded: Step[] = []
  let lastView = ''
  let lastStored = ''
  for (const step of scenario.steps) {
    storage.writes = []
    clipboard = null
    let result: Json = null
    switch (step.op) {
      // Set-up outside the backend: the clock, the disk, a restart.
      case 'clock':
        now = new Date(String(step.now))
        break
      case 'reopen':
        backend = open()
        break
      case 'setStored':
        if (step.value === null) storage.data.delete(String(step.key))
        else storage.data.set(String(step.key), resolve(String(step.value)))
        break
      case 'failWrites':
        storage.failWrites = step.keys === 'all'
        storage.failKeys = new Set(Array.isArray(step.keys) ? step.keys.map(String) : [])
        break
      case 'holdWrites':
        storage.gate = new Promise((resolve) => releases.push(resolve))
        break
      case 'holdEncrypt':
        encryptGate = new Promise((resolve) => releases.push(resolve))
        break
      case 'release':
        releases.splice(0).forEach((release) => release())
        storage.gate = undefined
        encryptGate = undefined
        await settle()
        break
      case 'begin':
        begun.set(String(step.as), step.step as Step)
        pending.set(String(step.as), call(step.step as Step))
        await settle()
        break
      case 'finish':
        result = await pending.get(String(step.as))!
        break
      default:
        result = await call(step)
    }
    const ran = step.op === 'finish' ? begun.get(String(step.as)) : step
    masker.learn(ran?.op === 'createLens' ? result : null, storage.data)
    const view = masker.maskDeep(backend.view())
    const stored = masker.maskDeep(Object.fromEntries([...storage.data].sort(([a], [b]) => (a < b ? -1 : 1))))
    // view and stored are left out when they are the same as after the step before.
    const viewText = JSON.stringify(view)
    const storedText = JSON.stringify(stored)
    const expected: { [key: string]: Json } = { result: masker.maskDeep(result), status: backend.status() }
    if (viewText !== lastView) expected.view = view
    if (storedText !== lastStored) expected.stored = stored
    expected.writes = masker.maskDeep(storage.writes)
    if (clipboard !== null) expected.clipboard = clipboard
    recorded.push({ ...step, expect: expected })
    lastView = viewText
    lastStored = storedText
  }
  return { ...scenario, steps: recorded }
}

const NOTES = {
  about:
    'What the TypeScript vault backend (src/platform/storage/backend.ts) did at v0.4.0, recorded by src/platform/storage/backend.behaviour.test.ts. ' +
    'Any vault backend must replay these scenarios and see the same results, except where a scenario says how Rust differs ("rust"). ' +
    'Never edit or regenerate this file to make a test pass.',
  setup:
    'Each scenario starts with empty storage, no keys, and the clock at 2026-10-08T12:00:00.000Z; `clock` steps change it. ' +
    'The crypto is a stand-in with real v1 blob shapes: every encryption makes a new blob, a blob opens only with its own key, ' +
    'and a value that is empty or only whitespace (JavaScript\'s definition) is refused.',
  operations: {
    backend:
      'status, create {password}, unlock {password}, lock, setAside, createLens {name, as?}, addItem {lens, label, type, value, as?}, ' +
      'updateItem {lens, item, label, type, value?} (no value: keep the stored one), deleteItem {lens, item}, renameLens {lens, name}, ' +
      'revealItem {lens, item}, copyItem {lens, item}, forgetLens {lens}, restoreLens {lens}, deleteLensForever {lens}.',
    setup:
      'clock {now}: sets the time. reopen: a new backend on the same storage with no keys held, as after a restart. ' +
      'setStored {key, value}: writes (or with null, removes) a stored value directly, outside the backend; it is not a write. ' +
      'failWrites {keys}: "all" makes every write fail; a list makes any write that touches a listed key fail; [] turns failures off. A failed write stores nothing.',
    concurrent:
      'holdWrites / holdEncrypt: writes or item encryptions wait until release. begin {as, step}: starts a step without waiting for it. ' +
      'finish {as}: waits for it and records its result.',
  },
  aliases:
    'The arguments lens, item, name and label, and setStored values, may use $X: an alias set by `as` (no other argument is resolved). ' +
    'createLens binds the new Lens id; addItem binds the id of the last secret in that Lens afterwards. In setStored values, $X.key is the stored ' +
    'encryptedMasterKey of the Lens with that id and $X.value the stored encryptedValue of the secret with that id, looked up in storage as it is ' +
    'before the step: the first match in still-lenses, then still-recycle-bin.',
  expect: {
    fields:
      'After each step: result; status; view; stored (every stored value, keys sorted); writes; and clipboard after a successful copy. ' +
      'view and stored appear only when they differ from the step before (a missing one is unchanged).',
    result:
      'null for a step with no result, the value returned (an id, a revealed value, an unlock result {ok, reason?}, a status, a set-aside prefix), ' +
      'or {error: code} when the step was refused.',
    view:
      '{lenses, bin, unreadable}: each readable Lens as {id, name, createdAt, itemCount, items: [{id, label, type}], deletedAt?} with values exactly as stored ' +
      '(deletedAt only when it is set and not empty); unreadable counts the Lenses in either list whose key did not open.',
    stored:
      'Compared as exact strings. Lists are written as JavaScript\'s JSON.stringify writes them: no spaces, fields in their stored order, a new field last ' +
      '(items and itemCount when a Lens had no items, deletedAt when forgotten), escapes like \\u0001, / and U+2028 not escaped, numbers like 2.5 and 1.',
    writes:
      'The keys of each successful write, in order, each write\'s keys in the order they were set. A change writes only the lists it changed, both in one write. ' +
      'setAside sets the copy, then removes the original, for each vault key in this order: still-encrypted-master-key, still-salt, still-has-pin, still-lenses, still-recycle-bin.',
    errors:
      'locked: the vault is locked (checked first). vault-exists: create with a vault or orphaned data present. unknown-lens: no such Lens in the active list ' +
      '(addItem, deleteItem, renameLens). unknown-item: no such secret (updateItem looks in the active list; revealItem and copyItem look in both lists, ' +
      'first matching Lens). empty-label / empty-name: blank after trimming. crypto-unknown-lens: the Lens\'s key did not open. empty-value: a blank value. ' +
      'crypto-corrupt: a stored value that does not decrypt. write-failed: a change could not be saved. storage-failed: create or setAside could not be saved.',
  },
  purge:
    'On unlock, Archive entries are removed unless deletedAt is a time after now minus 7 days (so one forgotten exactly 7 days ago goes), ' +
    'read as JavaScript\'s new Date(deletedAt ?? "") reads the standard ISO format (a date alone is UTC; offsets count). ' +
    'A missing, null or invalid deletedAt counts as expired. The purge is saved only if it removed something; if that save fails, unlocking still succeeds.',
  masking:
    'Generated ids and blobs are replaced by <id-N> and <blob-N>, numbered from 1 in order of first appearance, separately in each scenario. ' +
    'After each step, new ones are learned from: the result of a createLens step (also through finish); then each stored key in sorted order: ' +
    'a key ending in still-encrypted-master-key or still-salt is a blob; a key ending in still-lenses or still-recycle-bin, if it parses as a JSON list, ' +
    'gives for each Lens object its id (only if 32 lowercase hex digits) and encryptedMasterKey, then for each item object its id (same rule) and encryptedValue. ' +
    'A blob counts only if it is at least 16 characters of the base64 alphabet with up to two = at the end. Then every recorded string that equals a known value ' +
    'becomes its placeholder; any other string has each known value that appears as a double-quoted JSON string ("value") replaced by "placeholder".',
}

describe('vault backend behaviour (fixtures/vault-behaviour-v1)', () => {
  if (process.env.STILL_RECORD_BEHAVIOUR === '1') {
    it('records every scenario (refuses to overwrite)', async () => {
      const scenarios = []
      for (const scenario of SCENARIOS) scenarios.push(await runScenario(scenario))
      writeFileSync(FIXTURE, JSON.stringify({ ...NOTES, scenarios }, null, 2) + '\n', { flag: 'wx' })
    })
    return
  }

  const fixture = JSON.parse(readFileSync(FIXTURE, 'utf8'))

  it('covers exactly the scenarios defined here', () => {
    expect(fixture.scenarios.map((s: Scenario) => s.name)).toEqual(SCENARIOS.map((s) => s.name))
  })

  for (const [i, scenario] of SCENARIOS.entries()) {
    it(`replays ${scenario.name}`, async () => {
      const recorded = fixture.scenarios[i] as Scenario
      const actual = await runScenario(scenario)
      for (const [n, step] of actual.steps.entries()) {
        expect(step, `step ${n + 1}: ${step.op}`).toEqual(recorded.steps[n])
      }
      expect(actual.steps.length).toBe(recorded.steps.length)
    })
  }
})
