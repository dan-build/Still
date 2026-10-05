import { useState, useEffect, useRef } from 'react'
import LensView from '@/features/lenses/ui/LensView'
import NewLensDialog from '@/features/lenses/ui/NewLensDialog'
import RecycleBinModal from '@/features/recycle-bin/ui/RecycleBinModal'
import { onAutoLocked, reportActivity } from '@/platform/tauri/session'
import { createTauriVaultCrypto } from '@/platform/tauri/vaultCrypto'
import { createVaultBackend, type LensView as Lens, type VaultBackend, type VaultStorage, type VaultView } from '@/platform/storage/backend'
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
  /** Where the vault is stored: the vault file, opened by StillApp. */
  storage: VaultStorage
  /** Shown once, after the vault moved into its file or an older version changed the old copy. */
  notice?: keyof typeof NOTICES
}

export default function StillHome({ storage, notice }: StillHomeProps) {
  const backendRef = useRef<VaultBackend | null>(null)
  const [view, setView] = useState<VaultView>({ lenses: [], bin: [], unreadable: 0 })
  const [isCreateOpen, setIsCreateOpen] = useState(false)
  const [selection, setSelection] = useState<Selection | null>(null)
  const [isRecycleOpen, setIsRecycleOpen] = useState(false)
  const [toast, setToast] = useState<(ToastMessage & { id: number }) | null>(null)
  // Notices about where the vault lives stay until dismissed, unlike toasts.
  const [shownNotice, setShownNotice] = useState(notice)
  const toastTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)
  const toastId = useRef(0)
  const [isUnlocked, setIsUnlocked] = useState(false)
  const [isFirstLaunch, setIsFirstLaunch] = useState(false)
  const [isOrphaned, setIsOrphaned] = useState(false)

  // Created on first use. The keys live in Rust, behind the Tauri commands.
  const backend = () => {
    if (!backendRef.current) backendRef.current = createVaultBackend(storage, createTauriVaultCrypto())
    return backendRef.current
  }

  const refresh = () => setView(backend().view())

  const lenses = view.lenses
  const recycleBin = view.bin
  // The selected Lens, or the first (newest) one when none is chosen.
  const chosen = selection?.kind === 'lens' ? lenses.find((l) => l.id === selection.id) : undefined
  const currentLens: Lens | null = chosen ?? (selection?.kind === 'archive' ? null : (lenses[0] ?? null))
  const sidebarSelection: Selection | null = currentLens ? { kind: 'lens', id: currentLens.id } : selection

  useEffect(() => {
    // Rust keeps its keys across a page reload, but this page starts locked,
    // so have Rust forget them too. If that fails, the next unlock replaces them.
    backend().lock().catch(() => {})
    const status = backend().status()
    setIsFirstLaunch(status === 'empty')
    setIsOrphaned(status === 'orphaned')
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
      id = await backend().createLens(name)
    } catch {
      showToast(SAVE_FAILED)
      return false
    }
    refresh()
    setIsCreateOpen(false)
    setSelection({ kind: 'lens', id })
    return true
  }

  const forgetLens = async (lens: Lens) => {
    try {
      await backend().forgetLens(lens.id)
    } catch {
      showToast(SAVE_FAILED)
      return
    }
    refresh()
    setSelection(null)
    showToast({ message: `${lens.name} moved to Archive` })
  }

  const restoreFromRecycleBin = async (recycledLens: Lens) => {
    try {
      await backend().restoreLens(recycledLens.id)
    } catch {
      showToast(SAVE_FAILED)
      return
    }
    refresh()
    showToast({ message: 'Restored' })
  }

  const permanentDelete = async (id: string) => {
    try {
      await backend().deleteLensForever(id)
    } catch {
      showToast(SAVE_FAILED)
      return
    }
    refresh()
    showToast({ message: 'Permanently deleted' })
  }

  const handleCreatePassword = async (password: string) => {
    await backend().create(password)
    refresh()
    setIsUnlocked(true)
    setIsFirstLaunch(false)
    showToast({ message: 'Vault created' })
  }

  const handleUnlock = async (password: string): Promise<UnlockOutcome> => {
    let result
    try {
      result = await backend().unlock(password)
    } catch {
      return 'failed'
    }
    if (!result.ok) return result.reason === 'no-vault' ? 'failed' : result.reason
    refresh()
    setIsUnlocked(true)
    return 'ok'
  }

  const handleSetAside = async () => {
    await backend().setAside()
    setIsOrphaned(false)
    setIsFirstLaunch(true)
  }

  // Lock forgets everything shown: the crypto zeroes its keys, and the open
  // Lens, dialogs and any revealed values go with the unmounted UI.
  const lock = () => {
    backend().lock().catch(() => showToast({ message: "Couldn't clear the keys from memory. Quit Still to be sure.", tone: 'error' }))
    setIsUnlocked(false)
    setSelection(null)
    setIsCreateOpen(false)
    setIsRecycleOpen(false)
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
      if ((e.metaKey || e.ctrlKey) && !e.shiftKey && !e.altKey && e.key.toLowerCase() === 'l') {
        e.preventDefault()
        lock()
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
  }, [isUnlocked])

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
        <div data-ui="" className="flex h-screen w-full overflow-hidden bg-bg text-13 text-g1 [color-scheme:light_dark]">
          <Sidebar
            lenses={lenses}
            selected={sidebarSelection}
            archiveCount={recycleBin.length}
            onSelect={(next) => (next.kind === 'archive' ? setIsRecycleOpen(true) : setSelection(next))}
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
            {currentLens ? (
              <LensView
                key={currentLens.id}
                lens={currentLens}
                onAddItem={async (item) => {
                  await backend().addItem(currentLens.id, item)
                  refresh()
                }}
                onRevealItem={(itemId) => backend().revealItem(currentLens.id, itemId)}
                onCopyItem={(itemId) => backend().copyItem(currentLens.id, itemId)}
                onDeleteItem={async (itemId) => {
                  await backend().deleteItem(currentLens.id, itemId)
                  refresh()
                }}
                onToast={showToast}
                onForget={() => forgetLens(currentLens)}
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

          <NewLensDialog open={isCreateOpen} onClose={() => setIsCreateOpen(false)} onCreate={createLens} />

          <RecycleBinModal
            isOpen={isRecycleOpen}
            onClose={() => setIsRecycleOpen(false)}
            recycleBin={recycleBin}
            onRestore={restoreFromRecycleBin}
            onPermanentDelete={permanentDelete}
          />
        </div>
      )}

      {shownNotice && (
        <div
          data-ui=""
          role="status"
          className="fixed top-3 left-1/2 z-40 flex w-[min(560px,calc(100vw-2rem))] -translate-x-1/2 items-center gap-2.5 rounded-8 bg-sidebar py-2 pr-2 pl-3 text-13 leading-[1.45] text-g2 shadow-[inset_0_0_0_1px_var(--hairline)] [color-scheme:light_dark]"
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
