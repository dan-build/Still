import { useState, useEffect, useRef } from 'react'
import LensView from '@/features/lenses/ui/LensView'
import SearchView from '@/features/lenses/ui/SearchView'
import type { SecretOps } from '@/features/lenses/ui/SecretList'
import LensNameDialog from '@/features/lenses/ui/LensNameDialog'
import ArchiveView from '@/features/recycle-bin/ui/ArchiveView'
import { onAutoLocked, reportActivity } from '@/platform/tauri/session'
import { createTauriVaultApi, type VaultApi } from '@/platform/tauri/vaultApi'
import type { LensView as Lens, VaultState, VaultView } from '@/features/vault/model/types'
import { Button } from '@/shared/ui/Button'
import { Icon } from '@/shared/ui/Icon'
import { Toaster, type ToastMessage } from '@/shared/ui/Toast'
import Sidebar, { type Selection } from './shell/Sidebar'
import UnlockScreen, { type UnlockOutcome } from './lock/UnlockScreen'
import CreatePasswordScreen from './lock/CreatePasswordScreen'
import RecoveryScreen from './lock/RecoveryScreen'

// Activity is reported to Rust's auto-lock at most this often.
const ACTIVITY_EVERY_MS = 15_000

const NOTICES = {
  moved: 'Your vault now lives in its own file. The copy from before is kept, unchanged.',
  'old-copy-changed': 'An older version of Still changed its own copy of your vault. This version uses its file, which is unchanged; both are kept.',
}

interface StillHomeProps {
  /** Shown once, after the vault moved into its file or an older version changed the old copy. */
  notice?: keyof typeof NOTICES
}

export default function StillHome({ notice }: StillHomeProps) {
  const apiRef = useRef<VaultApi | null>(null)
  const [view, setView] = useState<VaultView>({ lenses: [], bin: [], unreadable: 0 })
  const [isCreateOpen, setIsCreateOpen] = useState(false)
  const [selection, setSelection] = useState<Selection | null>(null)
  // The sidebar search; while it has text, the main area shows the results.
  const [query, setQuery] = useState('')
  const searchField = useRef<HTMLInputElement>(null)
  const [toast, setToast] = useState<(ToastMessage & { id: number }) | null>(null)
  // Notices about where the vault lives stay until dismissed, unlike toasts.
  const [shownNotice, setShownNotice] = useState(notice)
  const toastTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)
  const toastId = useRef(0)
  // Until Rust has said which screen to show.
  const [isStarting, setIsStarting] = useState(true)
  const [isUnlocked, setIsUnlocked] = useState(false)
  const [isFirstLaunch, setIsFirstLaunch] = useState(false)
  const [isOrphaned, setIsOrphaned] = useState(false)

  // Created on first use. The vault and its keys live in Rust, behind the Tauri commands.
  const api = () => {
    if (!apiRef.current) apiRef.current = createTauriVaultApi()
    return apiRef.current
  }

  // Every change returns the vault as it now is.
  const show = (state: VaultState) => setView(state.view)

  const lenses = view.lenses
  const recycleBin = view.bin
  // The selected Lens, or the first (newest) one when none is chosen.
  const chosen = selection?.kind === 'lens' ? lenses.find((l) => l.id === selection.id) : undefined
  const currentLens: Lens | null = chosen ?? (selection?.kind === 'archive' ? null : (lenses[0] ?? null))
  const searching = query.trim() !== ''
  const showArchive = !searching && selection?.kind === 'archive'
  const sidebarSelection: Selection | null = searching ? null : currentLens ? { kind: 'lens', id: currentLens.id } : selection

  // Reveal, copy, edit and delete, for the Lens view and search alike.
  const ops: SecretOps = {
    reveal: (lensId, itemId) => api().revealItem(lensId, itemId),
    copy: (lensId, itemId) => api().copyItem(lensId, itemId),
    update: async (lensId, itemId, edit) => show(await api().updateItem(lensId, itemId, edit)),
    remove: async (lensId, itemId) => show(await api().deleteItem(lensId, itemId)),
  }

  useEffect(() => {
    // Rust keeps its keys across a page reload, but this page starts locked,
    // so have Rust forget them too. If that fails, the next unlock replaces them.
    api()
      .lock()
      .catch(() => {})
      .then(() => api().state())
      .then(({ status }) => {
        setIsFirstLaunch(status === 'empty')
        setIsOrphaned(status === 'orphaned')
      })
      // The unlock screen then reports what goes wrong.
      .catch(() => {})
      .finally(() => setIsStarting(false))
    // Once, when the app starts: api() is the same object for its life.
  }, [])

  // One toast at a time. Errors stay up longer; the copy toast stays until
  // the clipboard clears, its bar counting down.
  const showToast = (next: ToastMessage) => {
    clearTimeout(toastTimer.current)
    setToast({ ...next, id: ++toastId.current })
    const ms = next.countdown ? next.countdown * 1000 : next.tone === 'error' ? 6000 : 2200
    toastTimer.current = setTimeout(() => setToast(null), ms)
  }
  useEffect(() => () => clearTimeout(toastTimer.current), [])

  const SAVE_FAILED: ToastMessage = { message: "Couldn't save that change. Nothing was changed. Please try again.", tone: 'error' }

  const createLens = async (name: string) => {
    let id: string
    try {
      const created = await api().createLens(name)
      id = created.id
      show(created.state)
    } catch {
      showToast(SAVE_FAILED)
      return false
    }
    setIsCreateOpen(false)
    setSelection({ kind: 'lens', id })
    return true
  }

  const forgetLens = async (lens: Lens) => {
    try {
      show(await api().forgetLens(lens.id))
    } catch {
      showToast(SAVE_FAILED)
      return
    }
    setSelection(null)
    showToast({ message: `${lens.name} moved to Archive` })
  }

  const restoreFromRecycleBin = async (recycledLens: Lens) => {
    try {
      show(await api().restoreLens(recycledLens.id))
    } catch {
      showToast(SAVE_FAILED)
      return
    }
    showToast({ message: `${recycledLens.name} restored` })
  }

  const deleteForever = async (lens: Lens) => {
    try {
      show(await api().deleteLensForever(lens.id))
    } catch {
      showToast(SAVE_FAILED)
      return
    }
    showToast({ message: `${lens.name} deleted for good` })
  }

  const handleCreatePassword = async (password: string) => {
    const state = await api().create(password)
    show(state)
    setIsFirstLaunch(false)
    // A Lock while it was being created leaves the new vault saved but locked.
    setIsUnlocked(state.status === 'unlocked')
    showToast({ message: 'Vault created' })
  }

  const handleUnlock = async (password: string): Promise<UnlockOutcome> => {
    let result
    try {
      result = await api().unlock(password)
    } catch {
      return 'failed'
    }
    if (!result.ok) {
      if (result.reason !== 'no-vault') return result.reason
      // Start-up couldn't tell; there's no vault to unlock, so offer the right screen.
      const { status } = await api().state().catch(() => ({ status: 'locked' as const }))
      setIsFirstLaunch(status === 'empty')
      setIsOrphaned(status === 'orphaned')
      return 'failed'
    }
    show(result.state)
    setIsUnlocked(true)
    return 'ok'
  }

  const handleSetAside = async () => {
    await api().setAside()
    setIsOrphaned(false)
    setIsFirstLaunch(true)
  }

  // Lock forgets everything shown: Rust drops (and zeroes) its keys, and the
  // open Lens, dialogs and any revealed values go with the unmounted UI.
  const lock = () => {
    api().lock().catch(() => showToast({ message: "Couldn't clear the keys from memory. Quit Still to be sure.", tone: 'error' }))
    setIsUnlocked(false)
    setSelection(null)
    setQuery('')
    setIsCreateOpen(false)
    setView({ lenses: [], bin: [], unreadable: 0 })
    // A copy toast would outlive what it describes; Rust clears the clipboard on lock.
    setToast((current) => (current?.countdown ? null : current))
  }

  // While unlocked: tell Rust someone is here, follow it when it locks the
  // vault by itself (5 minutes idle, or the computer slept), and lock on ⌘L.
  useEffect(() => {
    if (!isUnlocked) return
    let last = 0
    const active = () => {
      const now = Date.now()
      if (now - last < ACTIVITY_EVERY_MS) return
      last = now
      reportActivity()
    }
    const shortcut = (e: KeyboardEvent) => {
      if (!(e.metaKey || e.ctrlKey) || e.shiftKey || e.altKey) return
      const key = e.key.toLowerCase()
      if (key === 'l') {
        e.preventDefault()
        lock()
      } else if (key === 'f') {
        // ⌘F: to the sidebar search.
        e.preventDefault()
        searchField.current?.focus()
        searchField.current?.select()
      }
    }
    const events = ['pointerdown', 'pointermove', 'keydown', 'wheel'] as const
    for (const name of events) window.addEventListener(name, active, { passive: true })
    window.addEventListener('keydown', shortcut)
    const stopListening = onAutoLocked((reason) => {
      lock()
      showToast({ message: reason === 'sleep' ? 'Locked while your computer was asleep.' : 'Locked after 5 minutes without activity.' })
    })
    return () => {
      for (const name of events) window.removeEventListener(name, active)
      window.removeEventListener('keydown', shortcut)
      stopListening()
    }
    // Per unlock: lock and showToast only use state setters and refs, so the
    // first render's copies stay correct.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isUnlocked])

  if (isStarting) return null

  return (
    <>
      {!isUnlocked ? (
        isOrphaned ? (
          <RecoveryScreen onSetAside={handleSetAside} />
        ) : isFirstLaunch ? (
          <CreatePasswordScreen onCreate={handleCreatePassword} />
        ) : (
          <UnlockScreen onUnlock={handleUnlock} />
        )
      ) : (
        <div className="flex h-screen w-full overflow-hidden bg-bg text-13 text-g1">
          <Sidebar
            lenses={lenses}
            selected={sidebarSelection}
            archiveCount={recycleBin.length}
            onSelect={(next) => {
              setQuery('')
              setSelection(next)
            }}
            query={query}
            onQuery={setQuery}
            searchRef={searchField}
            onNewLens={() => setIsCreateOpen(true)}
            onLock={lock}
          />
          <main className="flex min-w-0 flex-1 flex-col">
            {view.unreadable > 0 && (
              <div role="status" className="mx-3 mt-3 flex items-start gap-2.5 rounded-8 bg-sidebar px-3 py-3 text-13 leading-[1.45] text-g2 shadow-[inset_0_0_0_1px_var(--hairline)]">
                <Icon name="warning" className="mt-0.5 text-warning" />
                {view.unreadable === 1
                  ? "1 Lens couldn't be opened. It's kept safe and unchanged."
                  : `${view.unreadable} Lenses couldn't be opened. They're kept safe and unchanged.`}
              </div>
            )}
            {searching ? (
              <SearchView lenses={lenses} query={query} ops={ops} onClear={() => setQuery('')} onToast={showToast} />
            ) : showArchive ? (
              <ArchiveView bin={recycleBin} onRestore={restoreFromRecycleBin} onDeleteForever={deleteForever} />
            ) : currentLens ? (
              <LensView
                key={currentLens.id}
                lens={currentLens}
                onAddItem={async (item) => show(await api().addItem(currentLens.id, item))}
                ops={ops}
                onToast={showToast}
                onForget={() => forgetLens(currentLens)}
                onRename={async (name) => {
                  try {
                    show(await api().renameLens(currentLens.id, name))
                  } catch {
                    showToast(SAVE_FAILED)
                    return false
                  }
                  return true
                }}
              />
            ) : (
              <div className="flex flex-1 flex-col items-center justify-center gap-2 pb-10 text-center">
                <div className="mb-2 flex size-10 items-center justify-center rounded-8 bg-sidebar text-g4 shadow-[inset_0_0_0_1px_var(--hairline)]">
                  <Icon name="lens" />
                </div>
                <h1 className="text-14 font-semibold">No Lenses yet</h1>
                <p className="mb-3 max-w-[300px] text-13 leading-[1.5] text-g3">
                  A Lens is an encrypted collection of secrets. Make one for each part of your life.
                </p>
                <Button variant="primary" size="md" icon="plus" onClick={() => setIsCreateOpen(true)}>
                  Create a Lens
                </Button>
              </div>
            )}
          </main>

          <LensNameDialog open={isCreateOpen} onClose={() => setIsCreateOpen(false)} onSubmit={createLens} />
        </div>
      )}

      {shownNotice && (
        <div
         
          role="status"
          className="fixed top-3 left-1/2 z-40 flex w-[min(560px,calc(100vw-2rem))] -translate-x-1/2 items-center gap-2.5 rounded-8 bg-sidebar py-2 pr-2 pl-3 text-13 leading-[1.45] text-g2 shadow-[inset_0_0_0_1px_var(--hairline)]"
        >
          {shownNotice === 'old-copy-changed' && <Icon name="warning" className="text-warning" />}
          <p className="flex-1">{NOTICES[shownNotice]}</p>
          <Button onClick={() => setShownNotice(undefined)}>OK</Button>
        </div>
      )}

      {/* On every screen, so messages about locking show on the lock screen. */}
      <Toaster toast={toast} />
    </>
  )
}
