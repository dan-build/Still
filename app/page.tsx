'use client'

import { useState, useEffect } from 'react'
import CreateLensModal from './components/CreateLensModal'
import LensDetail from './components/LensDetail'
import RecycleBinModal from './components/RecycleBinModal'
import {
  generateMasterKey,
  uint8ArrayToBase64,
  base64ToUint8Array,
  encryptMasterKey,
  decryptMasterKey,
  encryptLensMasterKey,
  decryptLensMasterKey,
} from './lib/crypto'
import Image from 'next/image'
import UnlockScreen from './components/UnlockScreen'
import CreatePasswordScreen from './components/CreatePasswordScreen'

interface Item {
  id: string
  label: string
  type: 'password' | 'key' | 'note'
  encryptedValue: string
}

interface Lens {
  id: string
  name: string
  createdAt: string
  itemCount: number
  masterKey: Uint8Array
  items: Item[]
}

interface RecycledLens extends Lens {
  deletedAt: string
}


interface PersistedLens {
  id: string
  name: string
  createdAt: string
  itemCount: number
  encryptedMasterKey: string 
  items: Item[]
}

interface PersistedRecycledLens extends PersistedLens {
  deletedAt: string
}

export default function StillHome() {
  const [lenses, setLenses] = useState<Lens[]>([])
  const [recycleBin, setRecycleBin] = useState<RecycledLens[]>([])
  const [isCreateOpen, setIsCreateOpen] = useState(false)
  const [selectedLens, setSelectedLens] = useState<Lens | null>(null)
  const [isRecycleOpen, setIsRecycleOpen] = useState(false)
  const [toast, setToast] = useState('')
  const [isUnlocked, setIsUnlocked] = useState(false)
  const [isFirstLaunch, setIsFirstLaunch] = useState(false)
  const [hasPin, setHasPin] = useState(false)
  const [masterKey, setMasterKey] = useState<Uint8Array | null>(null)

  
  useEffect(() => {
    const loadData = async () => {
      const savedLenses = localStorage.getItem('still-lenses')
      const savedBin = localStorage.getItem('still-recycle-bin')

      
      if (!masterKey) return

      if (savedLenses) {
        try {
          const parsed: PersistedLens[] = JSON.parse(savedLenses)
          const restoredLenses: Lens[] = []

          for (const p of parsed) {
            try {
              const lensMasterKey = await decryptLensMasterKey(p.encryptedMasterKey, masterKey)
              restoredLenses.push({
                id: p.id,
                name: p.name,
                createdAt: p.createdAt,
                itemCount: p.itemCount,
                masterKey: lensMasterKey,
                items: p.items || [],
              })
            } catch (e) {
              console.error('Failed to decrypt lens key for', p.name, e)
            }
          }
          setLenses(restoredLenses)
        } catch (e) {
          console.error('Failed to load lenses', e)
        }
      }

      if (savedBin) {
        try {
          const parsed: PersistedRecycledLens[] = JSON.parse(savedBin)
          const restoredBin: RecycledLens[] = []

          for (const p of parsed) {
            try {
              const lensMasterKey = await decryptLensMasterKey(p.encryptedMasterKey, masterKey)
              restoredBin.push({
                id: p.id,
                name: p.name,
                createdAt: p.createdAt,
                itemCount: p.itemCount,
                masterKey: lensMasterKey,
                items: p.items || [],
                deletedAt: p.deletedAt,
              })
            } catch (e) {
              console.error('Failed to decrypt recycled lens key', e)
            }
          }
          setRecycleBin(restoredBin)
        } catch (e) {
          console.error('Failed to load recycle bin', e)
        }
      }

      cleanOldRecycleItems()
    }

    if (isUnlocked && masterKey) {
      loadData()
    }
  }, [isUnlocked, masterKey])

  
  useEffect(() => {
    const saveLenses = async () => {
      if (!masterKey || lenses.length === 0) return

      const persisted: PersistedLens[] = []
      for (const lens of lenses) {
        const encryptedMasterKey = await encryptLensMasterKey(lens.masterKey, masterKey)
        persisted.push({
          id: lens.id,
          name: lens.name,
          createdAt: lens.createdAt,
          itemCount: lens.itemCount,
          encryptedMasterKey,
          items: lens.items,
        })
      }
      localStorage.setItem('still-lenses', JSON.stringify(persisted))
    }

    saveLenses()
  }, [lenses, masterKey])

  
  useEffect(() => {
    const saveRecycleBin = async () => {
      if (!masterKey || recycleBin.length === 0) return

      const persisted: PersistedRecycledLens[] = []
      for (const lens of recycleBin) {
        const encryptedMasterKey = await encryptLensMasterKey(lens.masterKey, masterKey)
        persisted.push({
          id: lens.id,
          name: lens.name,
          createdAt: lens.createdAt,
          itemCount: lens.itemCount,
          encryptedMasterKey,
          items: lens.items,
          deletedAt: lens.deletedAt,
        })
      }
      localStorage.setItem('still-recycle-bin', JSON.stringify(persisted))
    }

    saveRecycleBin()
  }, [recycleBin, masterKey])

  
  useEffect(() => {
    const encryptedMasterKey = localStorage.getItem('still-encrypted-master-key')
    const salt = localStorage.getItem('still-salt')
    const pinExists = localStorage.getItem('still-has-pin') === 'true'

    if (encryptedMasterKey && salt) {
      setHasPin(pinExists)
      setIsFirstLaunch(false)
    } else {
      setIsFirstLaunch(true)
    }
  }, [])

  const cleanOldRecycleItems = () => {
    const now = new Date()
    const sevenDaysAgo = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000)
    setRecycleBin(prev => prev.filter(item => new Date(item.deletedAt) > sevenDaysAgo))
  }

  const showToast = (message: string) => {
    setToast(message)
    setTimeout(() => setToast(''), 2200)
  }

  
  const createLens = async (name: string) => {
    if (!masterKey) {
      showToast('Please unlock first')
      return
    }

    const newLensMasterKey = await generateMasterKey()
    const newLens: Lens = {
      id: Date.now().toString(36),
      name: name.trim(),
      createdAt: new Date().toISOString(),
      itemCount: 0,
      masterKey: newLensMasterKey,
      items: [],
    }

    setLenses(prev => [newLens, ...prev])
    setIsCreateOpen(false)
    setTimeout(() => setSelectedLens(newLens), 150)
  }

  const updateLensItems = (lensId: string, newItems: Item[]) => {
    setLenses(prev => prev.map(lens =>
      lens.id === lensId
        ? { ...lens, items: newItems, itemCount: newItems.length }
        : lens
    ))

    if (selectedLens && selectedLens.id === lensId) {
      setSelectedLens(prev => prev
        ? { ...prev, items: newItems, itemCount: newItems.length }
        : null
      )
    }
  }

  const moveToRecycleBin = (lens: Lens) => {
    const latestLens = lenses.find(l => l.id === lens.id) || lens
    const recycled: RecycledLens = {
      ...latestLens,
      deletedAt: new Date().toISOString()
    }

    setRecycleBin(prev => [recycled, ...prev])
    setLenses(prev => prev.filter(l => l.id !== lens.id))
    setSelectedLens(null)
    showToast('Moved to Recycle Bin')
  }

  const restoreFromRecycleBin = (recycledLens: RecycledLens) => {
    const { deletedAt, ...restoredLens } = recycledLens
    setLenses(prev => [restoredLens, ...prev])
    setRecycleBin(prev => prev.filter(l => l.id !== recycledLens.id))
    showToast('Restored')
  }

  const permanentDelete = (id: string) => {
    setRecycleBin(prev => prev.filter(l => l.id !== id))
    showToast('Permanently deleted')
  }

  const handleCreatePassword = async (password: string, pin?: string) => {
    const newMasterKey = await generateMasterKey()
    const { encryptedMasterKey, salt } = await encryptMasterKey(newMasterKey, password)

    localStorage.setItem('still-encrypted-master-key', encryptedMasterKey)
    localStorage.setItem('still-salt', salt)
    localStorage.setItem('still-has-pin', pin ? 'true' : 'false')

    setMasterKey(newMasterKey)
    setIsUnlocked(true)
    setIsFirstLaunch(false)
    showToast('Secure vault created')
  }

  const handleUnlock = async (password: string): Promise<boolean> => {
    try {
      const encryptedMasterKey = localStorage.getItem('still-encrypted-master-key')
      const salt = localStorage.getItem('still-salt')

      if (!encryptedMasterKey || !salt) return false

      const decryptedKey = await decryptMasterKey(encryptedMasterKey, password, salt)
      setMasterKey(decryptedKey)
      setIsUnlocked(true)
      return true
    } catch {
      return false
    }
  }

  return (
    <>
      {!isUnlocked ? (
        isFirstLaunch ? (
          <CreatePasswordScreen onCreate={handleCreatePassword} />
        ) : (
          <UnlockScreen onUnlock={handleUnlock} hasPin={hasPin} />
        )
      ) : (
        <div className="min-h-screen bg-[#F8F9FA] text-[#151515] flex justify-center">
          <div className="w-full max-w-[1080px] px-10">

            <header className="pt-10 pb-20 flex items-end">
              <div className="flex items-left">
                <Image
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
                        onClick={() => setSelectedLens(lenses[0])}
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
                        onClick={() => setSelectedLens(lens)}
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
                onClick={() => setIsUnlocked(false)}
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
              items={selectedLens.items}
              onClose={() => setSelectedLens(null)}
              onUpdateItems={(newItems) => updateLensItems(selectedLens.id, newItems)}
              onShowToast={showToast}
              onDeleteLens={moveToRecycleBin}
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
            <div className="fixed bottom-8 right-8 bg-white/70 backdrop-blur-xl text-[#151515]/80 text-sm px-6 py-2.5 rounded-[9px] border border-black/[0.04] flex items-center gap-2 z-[100]">
              <span>✓</span> {toast}
            </div>
          )}
        </div>
      )}
    </>
  )
}