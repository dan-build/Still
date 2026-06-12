'use client'

import { useState, useEffect, useRef } from 'react'
import { encrypt, decrypt } from '../lib/crypto'

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

interface LensDetailProps {
  lens: Lens
  items?: Item[]
  onClose: () => void
  onUpdateItems: (items: Item[]) => void
  onShowToast: (msg: string) => void
  onDeleteLens: (lens: Lens) => void
}

// Calm, premium stroke icons
const PasswordIcon = () => (
  <svg width="22" height="22" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
    <path d="M17 8.99994C17 8.48812 16.8047 7.9763 16.4142 7.58579C16.0237 7.19526 15.5118 7 15 7M15 15C18.3137 15 21 12.3137 21 9C21 5.68629 18.3137 3 15 3C11.6863 3 9 5.68629 9 9C9 9.27368 9.01832 9.54308 9.05381 9.80704C9.11218 10.2412 9.14136 10.4583 9.12172 10.5956C9.10125 10.7387 9.0752 10.8157 9.00469 10.9419C8.937 11.063 8.81771 11.1823 8.57913 11.4209L3.46863 16.5314C3.29568 16.7043 3.2092 16.7908 3.14736 16.8917C3.09253 16.9812 3.05213 17.0787 3.02763 17.1808C3 17.2959 3 17.4182 3 17.6627V19.4C3 19.9601 3 20.2401 3.10899 20.454C3.20487 20.6422 3.35785 20.7951 3.54601 20.891C3.75992 21 4.03995 21 4.6 21H7V19H9V17H11L12.5791 15.4209C12.8177 15.1823 12.937 15.063 13.0581 14.9953C13.1843 14.9248 13.2613 14.8987 13.4044 14.8783C13.5417 14.8586 13.7588 14.8878 14.193 14.9462C14.4569 14.9817 14.7263 15 15 15Z" />
  </svg>
)

const KeyIcon = () => (
  <svg width="22" height="22" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
    <path d="M17 10V8C17 5.23858 14.7614 3 12 3C9.23858 3 7 5.23858 7 8V10M12 14.5V16.5M8.8 21H15.2C16.8802 21 17.7202 21 18.362 20.673C18.9265 20.3854 19.3854 19.9265 19.673 19.362C20 18.7202 20 17.8802 20 16.2V14.8C20 13.1198 20 12.2798 19.673 11.638C19.3854 11.0735 18.9265 10.6146 18.362 10.327C17.7202 10 16.8802 10 15.2 10H8.8C7.11984 10 6.27976 10 5.63803 10.327C5.07354 10.6146 4.6146 11.0735 4.32698 11.638C4 12.2798 4 13.1198 4 14.8V16.2C4 17.8802 4 18.7202 4.32698 19.362C4.6146 19.9265 5.07354 20.3854 5.63803 20.673C6.27976 21 7.11984 21 8.8 21Z" />
  </svg>
)

const NoteIcon = () => (
  <svg width="22" height="22" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
    <path d="M20 10V6.8C20 5.11984 20 4.27976 19.673 3.63803C19.3854 3.07354 18.9265 2.6146 18.362 2.32698C17.7202 2 16.8802 2 15.2 2H8.8C7.11984 2 6.27976 2 5.63803 2.32698C5.07354 2.6146 4.6146 3.07354 4.32698 3.63803C4 4.27976 4 5.11984 4 6.8V17.2C4 18.8802 4 19.7202 4.32698 20.362C4.6146 20.9265 5.07354 21.3854 5.63803 21.673C6.27976 22 7.11984 22 8.8 22H10.5M13 11H8M11 15H8M16 7H8M19.25 17V15.25C19.25 14.2835 18.4665 13.5 17.5 13.5C16.5335 13.5 15.75 14.2835 15.75 15.25V17M15.6 21H19.4C19.9601 21 20.2401 21 20.454 20.891C20.6422 20.7951 20.7951 20.6422 20.891 20.454C21 20.2401 21 19.9601 21 19.4V18.6C21 18.0399 21 17.7599 20.891 17.546C20.7951 17.3578 20.6422 17.2049 20.454 17.109C20.2401 17 19.9601 17 19.4 17H15.6C15.0399 17 14.7599 17 14.546 17.109C14.3578 17.2049 14.2049 17.3578 14.109 17.546C14 17.7599 14 18.0399 14 18.6V19.4C14 19.9601 14 20.2401 14.109 20.454C14.2049 20.6422 14.3578 20.7951 14.546 20.891C14.7599 21 15.0399 21 15.6 21Z" />
  </svg>
)

export default function LensDetail({ 
  lens, 
  items = [], 
  onClose, 
  onUpdateItems, 
  onShowToast,
  onDeleteLens 
}: LensDetailProps) {

  const safeItems = items || []

  const [showAddModal, setShowAddModal] = useState(false)
  const [newLabel, setNewLabel] = useState('')
  const [newValue, setNewValue] = useState('')
  const [newType, setNewType] = useState<'password' | 'key' | 'note'>('password')
  const [revealed, setRevealed] = useState<Record<string, string>>({})
  const [isProcessing, setIsProcessing] = useState(false)
  const [showForgetConfirm, setShowForgetConfirm] = useState(false)

  const labelInputRef = useRef<HTMLInputElement>(null)
  const processingStartRef = useRef<number>(0)

  useEffect(() => {
    if (showAddModal && labelInputRef.current) {
      setTimeout(() => labelInputRef.current?.focus(), 100)
    }
  }, [showAddModal])

  const addItem = async () => {
    if (!newLabel.trim() || !newValue.trim()) return

    startProcessing()

    try {
      const encryptedValue = await encrypt(newValue.trim(), lens.masterKey)
      
      const newItem: Item = {
        id: Date.now().toString(36),
        label: newLabel.trim(),
        type: newType,
        encryptedValue,
      }

      const currentItems = items || []
      const updatedItems = [...currentItems, newItem]

      onUpdateItems(updatedItems)

      setNewLabel('')
      setNewValue('')
      setShowAddModal(false)

      onShowToast('Secret added successfully')
    } catch (error) {
      console.error('Encryption error:', error)
      onShowToast('Encryption failed. Please try again.')
    } finally {
      finishProcessing()
    }
  }

  const toggleReveal = async (item: Item) => {
    if (revealed[item.id]) {
      const { [item.id]: _, ...rest } = revealed
      setRevealed(rest)
    } else {
      startProcessing()
      try {
        const plaintext = await decrypt(item.encryptedValue, lens.masterKey)
        setRevealed(prev => ({ ...prev, [item.id]: plaintext }))
      } catch {
        onShowToast('Decryption failed')
      } finally {
        finishProcessing()
      }
    }
  }

  const copyToClipboard = async (item: Item) => {
    startProcessing()
    try {
      let text = revealed[item.id]
      if (!text) text = await decrypt(item.encryptedValue, lens.masterKey)
      await navigator.clipboard.writeText(text)
      onShowToast('Copied')
    } catch {
      onShowToast('Copy failed')
    } finally {
      finishProcessing()
    }
  }

  const deleteItem = (id: string) => {
    const updatedItems = safeItems.filter(i => i.id !== id)
    onUpdateItems(updatedItems)
    const { [id]: _, ...rest } = revealed
    setRevealed(rest)
    onShowToast('Deleted')
  }

  const finishProcessing = () => {
    const elapsed = Date.now() - processingStartRef.current
    const minVisibleTime = 480
    if (elapsed >= minVisibleTime) {
      setIsProcessing(false)
    } else {
      setTimeout(() => setIsProcessing(false), minVisibleTime - elapsed)
    }
  }

  const startProcessing = () => {
    processingStartRef.current = Date.now()
    setIsProcessing(true)
  }

  const requestForget = () => {
    setShowForgetConfirm(true)
  }

  const confirmForget = () => {
    const lensWithCurrentItems = {
      ...lens,
      items: safeItems
    }
    onDeleteLens(lensWithCurrentItems)
    setShowForgetConfirm(false)
  }

  return (
    <div className="fixed inset-0 z-[60] bg-[#F8F9FA] flex flex-col">
      <div className="h-[76px] border-b border-black/10 flex items-center px-10 flex-shrink-0" >
        <button
          onClick={onClose}
          className="flex items-center gap-2 text-sm text-[#151515]/60 hover:text-[#151515] transition-colors duration-200"
        >
          ← Back
        </button>

        <div className="flex-1 text-center">
          <div className="font-medium text-[19px] tracking-tight">{lens.name}</div>
          <div className="text-[11px] text-[#151515]/50 tracking-[1px] -mt-px">Local and Private.</div>
        </div>

        <button
          onClick={requestForget}
          className="text-xs text-red-600/70 hover:text-red-600 transition-colors px-4 py-2 rounded-[10px] hover:bg-red-50"
        >
          Forget Lens
        </button>
      </div>

      <div className="flex-1 max-w-[1080px] mx-auto w-full px-10 py-14 overflow-auto">
        <div className="flex items-end justify-between mb-10">
          <div>
            <div className="text-xs tracking-[1px] text-[#151515]/50">Inside this Lens</div>
            <div className="text-[34px] font-medium tracking-[-0.03em] mt-1 tabular-nums">{safeItems.length} secrets</div>
          </div>

          <button
            onClick={() => setShowAddModal(true)}
            disabled={isProcessing}
            className="h-11 px-6 bg-[#151515] text-white text-[13px] rounded-[12px]"
          >
            Add Secret
          </button>
        </div>

        {safeItems.length === 0 ? (
          <div className="text-center py-20 text-[#151515]/60 text-[15px]">This Lens is empty.<br />Add your first secret above.</div>
        ) : (
          <div className="space-y-3">
            {safeItems.map((item) => {
              const isRevealed = !!revealed[item.id]
              const displayValue = isRevealed 
                ? revealed[item.id] 
                : item.type === 'password' ? '••••••••••••••' : '••••••••••••'

              return (
                <div
                  key={item.id}
                  className="group bg-white border border-black/10 rounded-[18px] px-7 py-6 flex items-center justify-between hover:border-black/20 transition-all duration-300"
                >
                  <div className="flex items-center gap-5">
                    <div className="w-12 h-12 rounded-[12px] flex items-center justify-center text-[#151515]/70 flex-shrink-0">
                      {item.type === 'password' && <PasswordIcon />}
                      {item.type === 'key' && <KeyIcon />}
                      {item.type === 'note' && <NoteIcon />}
                    </div>
                    <div>
                      <div className="font-medium text-[17px]">{item.label}</div>
                      <div className="font-mono text-xs text-[#151515]/50 tracking-[2px] mt-px break-all">
                        {displayValue}
                      </div>
                    </div>
                  </div>

                  <div className="flex items-center gap-2 opacity-0 group-hover:opacity-100 transition-all duration-200">
                    <button
                      onClick={() => toggleReveal(item)}
                      disabled={isProcessing}
                      className="px-5 py-2 text-xs font-medium text-[#151515]/70 hover:text-[#151515] hover:bg-black/5 rounded-[10px] transition-colors"
                    >
                      {isRevealed ? 'Hide' : 'Reveal'}
                    </button>
                    <button
                      onClick={() => copyToClipboard(item)}
                      disabled={isProcessing}
                      className="px-5 py-2 text-xs font-medium text-[#151515]/70 hover:text-[#151515] hover:bg-black/5 rounded-[10px] transition-colors"
                    >
                      Copy
                    </button>
                    <button
                      onClick={() => deleteItem(item.id)}
                      className="px-5 py-2 text-xs font-medium text-red-600/70 hover:text-red-600 hover:bg-red-50 rounded-[10px] transition-colors"
                    >
                      Delete
                    </button>
                  </div>
                </div>
              )
            })}
          </div>
        )}
      </div>

      <div className="h-14 border-t border-black/10 flex items-center px-10 text-xs text-[#151515]/50 flex-shrink-0">
        This Lens stays encrypted on your device until you explicitly forget it.
      </div>

      {/* Add Secret Modal */}
      {showAddModal && (
        <div className="fixed inset-0 z-[70] flex items-center justify-center bg-black/40" onClick={() => setShowAddModal(false)}>
          <div className="bg-white rounded-[18px] p-8 w-full max-w-[380px] mx-4" onClick={e => e.stopPropagation()}>
            <div className="font-medium text-xl tracking-tight mb-6">Add new secret</div>

            <div className="space-y-5">
              <div>
                <div className="text-xs text-[#151515]/50 mb-1.5 tracking-wider">LABEL</div>
                <input
                  ref={labelInputRef}
                  value={newLabel}
                  onChange={(e) => setNewLabel(e.target.value)}
                  placeholder="What is this for?"
                  className="w-full bg-[#F8F9FA] px-5 py-3.5 rounded-[12px] text-sm focus:outline-none border border-black/10"
                />
              </div>

              <div>
                <div className="text-xs text-[#151515]/50 mb-1.5 tracking-wider">TYPE</div>
                <select
                  value={newType}
                  onChange={(e) => setNewType(e.target.value as any)}
                  className="w-full bg-[#F8F9FA] px-5 py-3.5 rounded-[12px] text-sm focus:outline-none border border-black/10"
                >
                  <option value="password">Password</option>
                  <option value="key">API Key / Token</option>
                  <option value="note">Secure Note</option>
                </select>
              </div>

              <div>
                <div className="text-xs text-[#151515]/50 mb-1.5 tracking-wider">VALUE</div>
                <textarea
                  value={newValue}
                  onChange={(e) => setNewValue(e.target.value)}
                  placeholder="Paste or type the secret here…"
                  rows={4}
                  className="w-full bg-[#F8F9FA] px-5 py-3.5 rounded-[12px] text-sm resize-y focus:outline-none border border-black/10"
                />
              </div>
            </div>

            <div className="flex gap-3 mt-8">
              <button onClick={() => setShowAddModal(false)} className="flex-1 py-3 text-sm text-[#151515]/70 hover:bg-[#F8F9FA] rounded-[12px] transition-colors">Cancel</button>
              <button
                onClick={addItem}
                disabled={!newLabel.trim() || !newValue.trim() || isProcessing}
                className="flex-1 py-3 bg-[#151515] text-white text-sm font-medium rounded-[12px] disabled:opacity-40 transition-colors"
              >
                {isProcessing ? 'Encrypting…' : 'Add to Lens'}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Forget Confirmation Modal */}
      {showForgetConfirm && (
        <div className="fixed inset-0 z-[80] flex items-center justify-center bg-black/40" onClick={() => setShowForgetConfirm(false)}>
          <div className="bg-white rounded-[18px] p-8 w-full max-w-[380px] mx-4 text-center" onClick={e => e.stopPropagation()}>
            <div className="text-4xl mb-4">··</div>
            <div className="font-medium text-xl tracking-tight mb-2">Move to Recycle Bin?</div>
            <p className="text-[#151515]/60 text-sm mb-8">
              All your secrets will be safely preserved.<br />You can restore this Lens anytime within 7 days.
            </p>

            <div className="flex gap-3">
              <button onClick={() => setShowForgetConfirm(false)} className="flex-1 py-3 text-sm text-[#151515]/70 hover:bg-[#F8F9FA] rounded-[12px] transition-colors">Cancel</button>
              <button
                onClick={confirmForget}
                className="flex-1 py-3 bg-red-600 hover:bg-red-700 text-white text-sm font-medium rounded-[12px] transition-colors"
              >
                Move to Recycle Bin
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Processing Overlay */}
      {isProcessing && (
        <div className="fixed inset-0 z-[90] flex items-center justify-center pointer-events-none">
          <div className="bg-white/95 backdrop-blur-md px-5 py-[9px] rounded-[14px] text-xs text-[#151515]/75 flex items-center gap-3 shadow-[0_2px_10px_rgb(0,0,0,0.04)] border border-black/[0.035]">
            <div className="relative flex h-[7px] w-[7px]">
              <div className="animate-ping absolute inline-flex h-full w-full rounded-full bg-[#151515] opacity-25"></div>
              <div className="relative inline-flex h-[7px] w-[7px] rounded-full bg-[#151515]"></div>
            </div>
            <span className="font-medium tracking-[0.5px]">Securing…</span>
          </div>
        </div>
      )}
    </div>
  )
}