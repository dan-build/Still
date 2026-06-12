'use client'

import { useState } from 'react'

interface CreateLensModalProps {
  isOpen: boolean
  onClose: () => void
  onCreate: (name: string) => void
}

export default function CreateLensModal({ isOpen, onClose, onCreate }: CreateLensModalProps) {
  const [name, setName] = useState('')

  if (!isOpen) return null

  const handleSubmit = () => {
    if (name.trim()) {
      onCreate(name)
      setName('')
    }
  }

  return (
    <div 
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/40"
      onClick={onClose}
    >
      <div 
        className="bg-white w-full max-w-[400px] mx-4 rounded-[18px] p-8"
        onClick={e => e.stopPropagation()}
      >
        <div className="text-center mb-8">
          <div className="mx-auto mb-5 w-14 h-14 rounded-[14px] flex items-center justify-center">
            <svg 
              width="32" 
              height="32" 
              viewBox="0 0 24 24" 
              fill="none" 
              xmlns="http://www.w3.org/2000/svg"
              className="text-[#151515]/60"
            >
              <path 
                d="M12 22C17.5228 22 22 17.5228 22 12C22 6.47715 17.5228 2 12 2C6.47715 2 2 6.47715 2 12C2 17.5228 6.47715 22 12 22Z" 
                stroke="currentColor" 
                strokeWidth="2" 
                strokeLinecap="round" 
                strokeLinejoin="round"
              />
            </svg>
          </div>
          <h2 className="text-[15px] font-medium">Create a new Lens</h2>
          <p className="text-[#151515]/60 text-[14px] mt-2 leading-snug">
            A secure, encrypted space on this device.<br />Protected by your master password.
          </p>
        </div>

        <div>
          <div className="text-xs tracking-[1.5px] text-[#151515]/50 mb-2 font-medium">Lens name</div>
          <input
            type="text"
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="e.g. Banking Keys"
            className="w-full bg-[#F8F9FA] border border-black/10 focus:border-black/30 rounded-[9px] px-5 py-4 text-[15px] placeholder:text-[#151515]/40 focus:outline-none transition-colors duration-200"
            onKeyDown={(e) => e.key === 'Enter' && handleSubmit()}
            autoFocus
          />
        </div>

        <div className="flex gap-3 mt-8">
          <button
            onClick={onClose}
            className="flex-1 py-3.5 text-sm font-medium text-[#151515]/70 hover:bg-[#F8F9FA] rounded-[9px] transition-colors duration-200"
          >
            Cancel
          </button>
          <button
            onClick={handleSubmit}
            disabled={!name.trim()}
            className="flex-1 py-3.5 bg-[#151515] text-white text-sm font-medium rounded-[9px] disabled:opacity-40 transition-colors duration-200"
          >
            Create Lens
          </button>
        </div>

        <div className="text-center mt-7 text-[12px] text-[#151515]/40">Local and Encrypted.</div>
      </div>
    </div>
  )
}