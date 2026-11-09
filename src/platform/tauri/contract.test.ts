// The page and Rust agree on the commands: their names, their argument names
// (Tauri reads them in camelCase from the Rust parameters), and the codes the
// page checks for. The Rust side is read from its source, so renaming a
// command, a parameter or a code on one side fails here.

import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, it, vi } from 'vitest'

const invoke = vi.fn()
vi.mock('@tauri-apps/api/core', () => ({ invoke: (...args: unknown[]) => invoke(...args) }))

import { createTauriVaultApi } from './vaultApi'
import { openOldFormat, openReplaced, openVault, restoreKeptCopy, restoreOldCopy } from './startup'
import { reportActivity } from './session'
import { fakeWebStorage } from '@/test/fakeWebStorage'

// fileURLToPath, not .pathname: on Windows that would be /D:/... .
const root = fileURLToPath(new URL('../../../', import.meta.url))
const read = (path: string) => readFileSync(join(root, path), 'utf8')

/** Every .rs file under these folders, as one text. */
function rustSources(...dirs: string[]): string {
  const texts: string[] = []
  const walk = (dir: string) => {
    for (const name of readdirSync(dir)) {
      const path = join(dir, name)
      if (statSync(path).isDirectory()) walk(path)
      else if (name.endsWith('.rs')) texts.push(readFileSync(path, 'utf8'))
    }
  }
  for (const dir of dirs) walk(join(root, dir))
  return texts.join('\n')
}

const camel = (name: string) => name.replace(/_([a-z])/g, (_, c: string) => c.toUpperCase())

/** Splits a parameter list on its top-level commas (generics hold commas too). */
function params(list: string): string[] {
  const out: string[] = []
  let depth = 0
  let current = ''
  for (const c of list) {
    if (c === '<') depth++
    if (c === '>') depth--
    if (c === ',' && depth === 0) {
      out.push(current)
      current = ''
    } else current += c
  }
  if (current.trim()) out.push(current)
  return out.map((p) => p.trim()).filter(Boolean)
}

/** Each #[tauri::command] in commands.rs: its name and the arguments the page must send. */
function rustCommands(): Map<string, string[]> {
  const source = read('src-tauri/src/commands.rs')
  const commands = new Map<string, string[]>()
  for (const [, name, list] of source.matchAll(/#\[tauri::command\]\s*pub (?:async )?fn (\w+)(?:<[^>]*>)?\(([^)]*)\)/g)) {
    const args = params(list)
      .map((p) => {
        const [arg, type] = p.split(/:\s*/, 2)
        return { arg: arg.trim(), type: type.trim() }
      })
      // Tauri fills these in itself.
      .filter(({ type }) => !type.startsWith('State<') && type !== 'AppHandle')
      .map(({ arg }) => camel(arg))
    commands.set(name, args.sort())
  }
  return commands
}

afterEach(() => invoke.mockReset())

describe('the contract between the page and the Rust commands', () => {
  const commands = rustCommands()

  it('reads every command from commands.rs', () => {
    const all = read('src-tauri/src/commands.rs').match(/pub const ALL: \[&str; (\d+)\]/)
    expect(commands.size).toBe(Number(all?.[1]))
    expect(commands.size).toBeGreaterThanOrEqual(30)
  })

  it('calls only commands Rust has, with exactly their arguments, and every one of them', async () => {
    invoke.mockImplementation(async (command: string) => (command.startsWith('startup_') ? { kind: 'ready' } : { state: {} }))
    const api = createTauriVaultApi()
    const legacy = fakeWebStorage({ 'still-salt': 's' })
    // Every way the page reaches Rust.
    await api.state()
    await api.create('pw')
    await api.unlock('pw')
    await api.lock()
    await api.setAside()
    await api.changePassword('a', 'b', false)
    await api.backupSave()
    await api.restoreChoose()
    await api.restoreCheck('pw')
    await api.restoreConfirm()
    await api.keptList()
    await api.keptTrash('vault-v1.json')
    await api.createLens('n')
    await api.renameLens('l', 'n')
    await api.forgetLens('l')
    await api.restoreLens('l')
    await api.deleteLensForever('l')
    await api.addItem('l', { label: 'x', type: 'password', value: 'v' })
    await api.updateItem('l', 'i', { label: 'x', type: 'password', value: 'v' })
    await api.deleteItem('l', 'i')
    await api.restoreItem('l', 'i')
    await api.revealItem('l', 'i')
    await api.copyItem('l', 'i')
    await api.generatePassword({ length: 20, lower: true, upper: true, digits: true, symbols: true, avoidLookAlikes: true })
    await openVault(legacy)
    await restoreOldCopy(legacy)
    await openOldFormat(false)
    await openReplaced(legacy)
    await restoreKeptCopy()
    reportActivity()

    const called = new Set<string>()
    for (const [command, args] of invoke.mock.calls as [string, Record<string, unknown> | undefined][]) {
      expect(commands.has(command), `${command} isn't a Rust command`).toBe(true)
      expect(Object.keys(args ?? {}).sort(), `${command}'s arguments`).toEqual(commands.get(command))
      called.add(command)
    }
    expect([...commands.keys()].filter((command) => !called.has(command)), 'Rust commands the page never calls').toEqual([])
  })

  // The codes the page acts on (an error, an unlock failure, a start-up
  // outcome, a status or a notice) must be ones Rust sends.
  it('checks only for codes Rust sends', () => {
    const rust = rustSources('src-tauri/src', 'crates/still-core/src')
    const page = [
      'src/app/App.tsx',
      'src/app/StillApp.tsx',
      'src/app/lock/UnlockScreen.tsx',
      'src/features/vault/ui/ChangePasswordDialog.tsx',
      'src/features/vault/ui/RestoreBackupDialog.tsx',
      'src/features/vault/model/types.ts',
      'src/platform/tauri/startup.ts',
    ]
      .map(read)
      .join('\n')
    const codes = new Set<string>()
    const collect = (pattern: RegExp, text = page) => {
      for (const match of text.matchAll(pattern)) codes.add(match[1])
    }
    collect(/(?:code|reason) === '([a-z0-9-]+)'/g)
    collect(/case '([a-z0-9-]+)'/g)
    // Union types of codes: reason, kind, notice and status.
    for (const [, union] of page.matchAll(/(?:reason|kind|notice|status)\??: ((?:'[a-z0-9-]+'\s*\|?\s*)+)/g)) {
      collect(/'([a-z0-9-]+)'/g, union)
    }
    // UnlockScreen's messages, by outcome.
    collect(/^\s+'([a-z]+(?:-[a-z]+)+)': ["']/gm, read('src/app/lock/UnlockScreen.tsx'))

    expect(codes.size).toBeGreaterThan(20)
    // Page-only values: the sidebar's selection, and the unlock screen's 'ok'.
    const pageOnly = new Set(['lens', 'archive', 'ok'])
    const missing = [...codes].filter((code) => !pageOnly.has(code) && !rust.includes(`"${code}"`))
    expect(missing, 'codes the page checks for that Rust never sends').toEqual([])
  })
})
