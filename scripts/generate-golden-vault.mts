// Generates the golden v1 vault fixture with the app's own crypto code, so
// the fixture is exactly what the current app writes to localStorage.
//
// Run once, then commit the output. Never regenerate it to make a failing
// test pass: the point of a golden fixture is that it does not change.
//
//   node scripts/generate-golden-vault.mts [--force]

import { existsSync, mkdirSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  encrypt,
  encryptLensMasterKey,
  encryptMasterKey,
  generateMasterKey,
} from '../src/test/reference/crypto.ts'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const outDir = join(root, 'fixtures', 'vault-v1')
const vaultPath = join(outDir, 'vault.json')
const expectedPath = join(outDir, 'expected.json')

if ((existsSync(vaultPath) || existsSync(expectedPath)) && !process.argv.includes('--force')) {
  console.error(`${outDir} already exists. Pass --force only if you really mean to replace the golden fixture.`)
  process.exit(1)
}

// Test-only password. Non-ASCII on purpose: the app passes the UTF-8 bytes of
// the password to Argon2id with no normalisation.
const PASSWORD = 'Stíll-golden-v1 🔑 horse'

type ItemType = 'password' | 'key' | 'note'
type ItemSpec = { id: string; label: string; type: ItemType; value: string }
type LensSpec = { id: string; name: string; createdAt: string; items: ItemSpec[]; deletedAt?: string }

const longNote = Array.from(
  { length: 80 },
  (_, i) => `Line ${String(i + 1).padStart(2, '0')}: the quick brown fox jumps over the lazy dog. ✓`,
).join('\n')

// Ids follow the app's Date.now().toString(36) format, from fixed timestamps.
const id = (iso: string) => Date.parse(iso).toString(36)

const lenses: LensSpec[] = [
  {
    id: id('2026-01-10T09:00:00.000Z'),
    name: 'Personal',
    createdAt: '2026-01-10T09:00:00.000Z',
    items: [
      { id: id('2026-01-10T09:01:00.000Z'), label: 'Email', type: 'password', value: 'hunter2-Ünïcødé-密码-🔐' },
      { id: id('2026-01-10T09:02:00.000Z'), label: 'API token', type: 'key', value: 'sk-test-0123456789abcdef' },
      {
        id: id('2026-01-10T09:03:00.000Z'),
        label: 'SSH key',
        type: 'key',
        value: '-----BEGIN DUMMY KEY-----\nAAAAB3NzaC1yc2EAAAADAQABAAABAQDummyDummyDummy\n-----END DUMMY KEY-----\n',
      },
      { id: id('2026-01-10T09:04:00.000Z'), label: 'Long note', type: 'note', value: longNote },
      // The UI trims values before encrypting (audit finding B3); these go
      // through encrypt() directly to record what the crypto layer stores.
      { id: id('2026-01-10T09:05:00.000Z'), label: 'Spaced password', type: 'password', value: '  spaced out  ' },
      { id: id('2026-01-10T09:06:00.000Z'), label: 'Indented note', type: 'note', value: '\tindented\nline two\n' },
      { id: id('2026-01-10T09:07:00.000Z'), label: 'One character', type: 'password', value: 'x' },
    ],
  },
  {
    id: id('2026-02-01T12:00:00.000Z'),
    name: 'Empty lens',
    createdAt: '2026-02-01T12:00:00.000Z',
    items: [],
  },
]

const recycleBin: LensSpec[] = [
  {
    id: id('2025-12-01T08:00:00.000Z'),
    name: 'Old work',
    createdAt: '2025-12-01T08:00:00.000Z',
    deletedAt: '2026-09-27T10:00:00.000Z',
    items: [{ id: id('2025-12-01T08:01:00.000Z'), label: 'VPN', type: 'password', value: 'correct-horse' }],
  },
]

const appMasterKey = await generateMasterKey()
const { encryptedMasterKey, salt } = await encryptMasterKey(appMasterKey, PASSWORD)

// Mirrors PersistedLens / PersistedRecycledLens in src/app/App.tsx, including
// property order, so the JSON matches what the app writes.
async function persist(spec: LensSpec) {
  const lensKey = await generateMasterKey()
  const items = []
  for (const item of spec.items) {
    items.push({
      id: item.id,
      label: item.label,
      type: item.type,
      encryptedValue: await encrypt(item.value, lensKey),
    })
  }
  return {
    id: spec.id,
    name: spec.name,
    createdAt: spec.createdAt,
    itemCount: items.length,
    encryptedMasterKey: await encryptLensMasterKey(lensKey, appMasterKey),
    items,
    ...(spec.deletedAt ? { deletedAt: spec.deletedAt } : {}),
  }
}

const persistedLenses = []
for (const lens of lenses) persistedLenses.push(await persist(lens))
const persistedBin = []
for (const lens of recycleBin) persistedBin.push(await persist(lens))

// Exactly the localStorage keys and string values the app stores.
const vault = {
  'still-encrypted-master-key': encryptedMasterKey,
  'still-salt': salt,
  'still-has-pin': 'false',
  'still-lenses': JSON.stringify(persistedLenses),
  'still-recycle-bin': JSON.stringify(persistedBin),
}

const plaintexts = (specs: LensSpec[]) =>
  Object.fromEntries(
    specs.map((lens) => [
      lens.id,
      { name: lens.name, items: Object.fromEntries(lens.items.map((item) => [item.id, item.value])) },
    ]),
  )

const expected = {
  password: PASSWORD,
  lenses: plaintexts(lenses),
  recycleBin: plaintexts(recycleBin),
}

mkdirSync(outDir, { recursive: true })
writeFileSync(vaultPath, JSON.stringify(vault, null, 2) + '\n')
writeFileSync(expectedPath, JSON.stringify(expected, null, 2) + '\n')
console.log(`Wrote ${vaultPath} and ${expectedPath}`)
