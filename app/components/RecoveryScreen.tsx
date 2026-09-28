'use client'

import { useState } from 'react'

interface RecoveryScreenProps {
  onSetAside: () => Promise<void>
}

// Shown when Still finds saved vault data but not the key that opens it.
// Creating a new vault on top would leave that data unreadable, so the only
// way forward is to set it aside first, after a clear confirmation.
export default function RecoveryScreen({ onSetAside }: RecoveryScreenProps) {
  const [confirming, setConfirming] = useState(false)
  const [isWorking, setIsWorking] = useState(false)
  const [error, setError] = useState('')

  const setAside = async () => {
    setIsWorking(true)
    setError('')
    try {
      await onSetAside()
    } catch {
      setError("Still couldn't set the old data aside. Nothing was changed.")
      setIsWorking(false)
    }
  }

  return (
    <div className="min-h-screen flex items-center justify-center bg-[#F8F9FA] px-6">
      <div className="w-full max-w-[460px]">
        {!confirming ? (
          <div>
            <h1 className="text-[28px] font-medium tracking-tight text-center">Still found data it can't open</h1>
            <div className="text-[#151515]/70 mt-5 text-[15px] leading-relaxed space-y-3">
              <p>
                Your saved Lenses are still on this Mac, but the key that unlocks them is missing, so Still can't open
                them. Creating a new vault now would leave them unreadable for good, so Still won't do that on its own.
              </p>
              <p>If you have a backup of Still's data, restore it and open Still again.</p>
              <p>
                Otherwise, you can set the old data aside and start a new, empty vault. Nothing is deleted: the old data
                stays on this Mac under a different name.
              </p>
            </div>
            <button
              onClick={() => setConfirming(true)}
              className="mt-8 w-full py-4 bg-[#151515] text-white text-sm font-medium rounded-[14px] transition-all active:scale-[0.985]"
            >
              Set the old data aside…
            </button>
          </div>
        ) : (
          <div>
            <h1 className="text-[28px] font-medium tracking-tight text-center">Set the old data aside?</h1>
            <div className="text-[#151515]/70 mt-5 text-[15px] leading-relaxed space-y-3">
              <p>Still will keep a copy of everything it found, then start a new, empty vault.</p>
              <p>
                The old Lenses stay unreadable unless the missing key is restored. They won't appear in the new vault.
              </p>
            </div>
            {error && <div className="text-red-600 text-sm text-center pt-4">{error}</div>}
            <div className="flex gap-3 mt-8">
              <button
                onClick={() => setConfirming(false)}
                disabled={isWorking}
                className="flex-1 py-3.5 text-sm font-medium text-[#151515]/70 hover:bg-white rounded-[14px] transition-colors"
              >
                Cancel
              </button>
              <button
                onClick={setAside}
                disabled={isWorking}
                className="flex-1 py-3.5 bg-[#151515] text-white text-sm font-medium rounded-[14px] disabled:opacity-50 transition-all active:scale-[0.985]"
              >
                {isWorking ? 'Setting aside…' : 'Set aside and start fresh'}
              </button>
            </div>
          </div>
        )}
      </div>
    </div>
  )
}
