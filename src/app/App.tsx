import { useState, useEffect, useRef } from 'react'
import CreateLensModal from '@/features/lenses/ui/CreateLensModal'
import LensDetail from '@/features/lenses/ui/LensDetail'
import RecycleBinModal from '@/features/recycle-bin/ui/RecycleBinModal'
import * as cryptoModule from '@/platform/crypto/crypto'
import { createLocalStorageBackend, type LensView, type VaultBackend, type VaultView } from '@/platform/storage/backend'
import UnlockScreen, { type UnlockOutcome } from './lock/UnlockScreen'
import CreatePasswordScreen from './lock/CreatePasswordScreen'
import RecoveryScreen from './lock/RecoveryScreen'

export default function StillHome() {
  const backendRef = useRef<VaultBackend | null>(null)
  const [view, setView] = useState<VaultView>({ lenses: [], bin: [], unreadable: 0 })
  const [isCreateOpen, setIsCreateOpen] = useState(false)
  const [selectedLensId, setSelectedLensId] = useState<string | null>(null)
  const [isRecycleOpen, setIsRecycleOpen] = useState(false)
  const [toast, setToast] = useState<{ message: string; error: boolean } | null>(null)
  const toastTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)
  const [isUnlocked, setIsUnlocked] = useState(false)
  const [isFirstLaunch, setIsFirstLaunch] = useState(false)
  const [isOrphaned, setIsOrphaned] = useState(false)

  // Created on first use: the static export renders without a window.
  const backend = () => {
    if (!backendRef.current) backendRef.current = createLocalStorageBackend(window.localStorage, cryptoModule)
    return backendRef.current
  }

  const refresh = () => setView(backend().view())

  const lenses = view.lenses
  const recycleBin = view.bin
  const selectedLens = lenses.find(l => l.id === selectedLensId) ?? null

  useEffect(() => {
    const status = backend().status()
    setIsFirstLaunch(status === 'empty')
    setIsOrphaned(status === 'orphaned')
  }, [])

  // Errors stay up longer and replace any earlier toast instead of racing its timer.
  const showToast = (message: string, error = false) => {
    clearTimeout(toastTimer.current)
    setToast({ message, error })
    toastTimer.current = setTimeout(() => setToast(null), error ? 6000 : 2200)
  }

  const SAVE_FAILED = "Couldn't save that change. Nothing was changed. Please try again."

  const createLens = async (name: string) => {
    let id: string
    try {
      id = await backend().createLens(name)
    } catch {
      showToast(SAVE_FAILED, true)
      return
    }
    refresh()
    setIsCreateOpen(false)
    setTimeout(() => setSelectedLensId(id), 150)
  }

  const moveToRecycleBin = async (lens: LensView) => {
    try {
      await backend().forgetLens(lens.id)
    } catch {
      showToast(SAVE_FAILED, true)
      return
    }
    refresh()
    setSelectedLensId(null)
    showToast('Moved to Recycle Bin')
  }

  const restoreFromRecycleBin = async (recycledLens: LensView) => {
    try {
      await backend().restoreLens(recycledLens.id)
    } catch {
      showToast(SAVE_FAILED, true)
      return
    }
    refresh()
    showToast('Restored')
  }

  const permanentDelete = async (id: string) => {
    try {
      await backend().deleteLensForever(id)
    } catch {
      showToast(SAVE_FAILED, true)
      return
    }
    refresh()
    showToast('Permanently deleted')
  }

  const handleCreatePassword = async (password: string) => {
    await backend().create(password)
    refresh()
    setIsUnlocked(true)
    setIsFirstLaunch(false)
    showToast('Secure vault created')
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

  // Lock forgets everything shown: keys are zeroed in the backend, and the
  // open Lens, modals and any revealed values go with the unmounted UI.
  const lock = () => {
    backend().lock()
    setIsUnlocked(false)
    setSelectedLensId(null)
    setIsCreateOpen(false)
    setIsRecycleOpen(false)
    setView({ lenses: [], bin: [], unreadable: 0 })
  }

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
        <div className="min-h-screen bg-[#F8F9FA] text-[#151515] flex justify-center">
          <div className="w-full max-w-[1080px] px-10">

            <header className="pt-10 pb-20 flex items-end">
              <div className="flex items-left">
                <img
                  src="/still.svg"
                  alt="Still Logo"
                  width={48}
                  height={48}
                />
              </div>

              <div className="ml-auto flex items-center gap-3">
                <button
                  onClick={() => setIsRecycleOpen(true)}
                  className="text-sm text-[#151515]/40 hover:text-[#151515] transition"
                >
                  Archive
                </button>

                <button
                  onClick={() => setIsCreateOpen(true)}
                  className="text-sm text-[#151515]/40 hover:text-[#151515] transition"
                >
                  New Lens
                </button>
              </div>
            </header>

            <main className="space-y-14">
              {view.unreadable > 0 && (
                <div role="status" className="rounded-[12px] border border-black/10 bg-white px-5 py-4 text-sm text-[#151515]/80">
                  {view.unreadable === 1
                    ? "1 Lens couldn't be opened. It's kept safe and unchanged."
                    : `${view.unreadable} Lenses couldn't be opened. They're kept safe and unchanged.`}
                </div>
              )}
              {lenses.length === 0 ? (
                <div className="min-h-[60vh] flex flex-col justify-center">
                  <div className="relative">
                    <div className="text-[34px] font-medium leading-[0.5]">
                      Your storage
                    </div>
                    <div className="absolute -top-6 -right-6 w-24 h-24 rounded-full bg-black/5 blur-2xl" />
                  </div>

                  <div className="mt-6 max-w-[420px] text-[#151515]/55 text-[14px] leading-relaxed">
                    Local. Encrypted. No accounts.<br />
                    Protected by your master password.
                  </div>

                  <button
                    onClick={() => setIsCreateOpen(true)}
                    className="mt-10 w-fit px-5 h-9 bg-[#151515] text-white rounded-[9px] text-sm"
                  >
                    Create your first lens
                  </button>
                </div>
              ) : (
                <div className="grid grid-cols-12 gap-10">
                  <div className="col-span-7">
                    <div className="sticky top-10 space-y-4">
                      <div className="text-[11px] tracking-[0.2em] uppercase text-[#151515]/40">
                        Active Lens
                      </div>

                      <div
                        onClick={() => setSelectedLensId(lenses[0].id)}
                        className="bg-[#ECEFF1] rounded-[28px] p-10 min-h-[420px] flex flex-col justify-between cursor-pointer hover:bg-[#DDE2E7] transition-all duration-500"
                      >
                        <div>
                          <div className="text-[44px] tracking-[-0.06em] leading-[0.95]">
                            {lenses[0]?.name}
                          </div>
                          <div className="mt-6 text-sm text-[#151515]/50">
                            {lenses[0]?.itemCount} items stored locally
                          </div>
                        </div>
                        <div className="text-[12px] uppercase tracking-[0.2em] text-[#151515]/30">
                          Primary collection
                        </div>
                      </div>
                    </div>
                  </div>

                  <div className="col-span-5 space-y-3">
                    <div className="text-[11px] tracking-[0.2em] uppercase text-[#151515]/40 mb-4">
                      All Lenses
                    </div>

                    {lenses.map((lens, i) => (
                      <div
                        key={lens.id}
                        onClick={() => setSelectedLensId(lens.id)}
                        className="group cursor-pointer px-5 py-4 rounded-[16px] bg-white/60 hover:bg-white transition flex justify-between items-center"
                      >
                        <div className="text-[15px] tracking-[-0.02em] group-hover:translate-x-1 transition">
                          {lens.name}
                        </div>
                        <div className="text-xs text-[#151515]/40">
                          {lens.itemCount}
                        </div>
                      </div>
                    ))}
                  </div>
                </div>
              )}
            </main>

            <footer className="py-14 flex items-center justify-between text-[12px] text-[#151515]/30 tracking-[0.1em]">
              <div>Private.</div>

              <button
                onClick={lock}
                className="flex items-center gap-2 px-4 py-2 text-sm text-[#151515]/60 hover:text-[#151515] transition"
                title="Lock app"
              >
                <svg
                  width="18"
                  height="18"
                  viewBox="0 0 24 24"
                  fill="none"
                  xmlns="http://www.w3.org/2000/svg"
                >
                  <path
                    d="M7 11V8C7 5.23858 9.23858 3 12 3C14.419 3 16.4367 4.71776 16.9 7M8.8 21H15.2C16.8802 21 17.7202 21 18.362 20.673C18.9265 20.3854 19.3854 19.9265 19.673 19.362C20 18.7202 20 17.8802 20 16.2V15.8C20 14.1198 20 13.2798 19.673 12.638C19.3854 12.0735 18.9265 11.6146 18.362 11.327C17.7202 11 16.8802 11 15.2 11H8.8C7.11984 11 6.27976 11 5.63803 11.327C5.07354 11.6146 4.6146 12.0735 4.32698 12.638C4 13.2798 4 14.1198 4 15.8V16.2C4 17.8802 4 18.7202 4.32698 19.362C4.6146 19.9265 5.07354 20.3854 5.63803 20.673C6.27976 21 7.11984 21 8.8 21Z"
                    stroke="currentColor"
                    strokeWidth="2"
                    strokeLinecap="round"
                    strokeLinejoin="round"
                  />
                </svg>
                <span>Lock</span>
              </button>
            </footer>
          </div>

          <CreateLensModal isOpen={isCreateOpen} onClose={() => setIsCreateOpen(false)} onCreate={createLens} />

          {selectedLens && (
            <LensDetail
              lens={selectedLens}
              onClose={() => setSelectedLensId(null)}
              onAddItem={async (item) => { await backend().addItem(selectedLens.id, item); refresh() }}
              onRevealItem={(itemId) => backend().revealItem(selectedLens.id, itemId)}
              onDeleteItem={async (itemId) => { await backend().deleteItem(selectedLens.id, itemId); refresh() }}
              onShowToast={showToast}
              onForget={() => moveToRecycleBin(selectedLens)}
            />
          )}

          <RecycleBinModal
            isOpen={isRecycleOpen}
            onClose={() => setIsRecycleOpen(false)}
            recycleBin={recycleBin}
            onRestore={restoreFromRecycleBin}
            onPermanentDelete={permanentDelete}
          />

          {toast && (
            <div
              role={toast.error ? 'alert' : 'status'}
              className={`fixed bottom-8 right-8 bg-white/70 backdrop-blur-xl text-sm px-6 py-2.5 rounded-[9px] border border-black/[0.04] flex items-center gap-2 z-[100] ${toast.error ? 'text-red-700' : 'text-[#151515]/80'}`}
            >
              {!toast.error && <span>✓</span>} {toast.message}
            </div>
          )}
        </div>
      )}
    </>
  )
}