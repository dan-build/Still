'use client'

import { useState } from 'react'

interface UnlockScreenProps {
  onUnlock: (password: string) => Promise<boolean>
  hasPin: boolean
}

export default function UnlockScreen({ onUnlock, hasPin }: UnlockScreenProps) {
  const [input, setInput] = useState('')
  const [usePin, setUsePin] = useState(false)
  const [error, setError] = useState('')
  const [isLoading, setIsLoading] = useState(false)

  const handleUnlock = async () => {
    if (!input.trim()) return

    setIsLoading(true)
    setError('')

    try {
      const success = await onUnlock(input)
      if (!success) {
        setError('Incorrect password or PIN')
        setInput('')
      }
    } catch (err) {
      setError('Something went wrong. Please try again.')
    } finally {
      setIsLoading(false)
    }
  }

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter') {
      handleUnlock()
    }
  }

  return (
    <div className="min-h-screen flex items-center justify-center bg-[#F8F9FA]">
      <div className="w-full max-w-[400px] px-6">
        <div className="text-center mb-10">
          <div className="mx-auto mb-6 w-16 h-16 rounded-2xl flex items-center justify-center">
            <svg 
              width="36" 
              height="36" 
              viewBox="0 0 24 24" 
              fill="none" 
              xmlns="http://www.w3.org/2000/svg"
              className="text-[#151515]"
            >
              <path 
                d="M17 11V8C17 5.23858 14.7614 3 12 3C9.23858 3 7 5.23858 7 8V11M8.8 21H15.2C16.8802 21 17.7202 21 18.362 20.673C18.9265 20.3854 19.3854 19.9265 19.673 19.362C20 18.7202 20 17.8802 20 16.2V15.8C20 14.1198 20 13.2798 19.673 12.638C19.3854 12.0735 18.9265 11.6146 18.362 11.327C17.7202 11 16.8802 11 15.2 11H8.8C7.11984 11 6.27976 11 5.63803 11.327C5.07354 11.6146 4.6146 12.0735 4.32698 12.638C4 13.2798 4 14.1198 4 15.8V16.2C4 17.8802 4 18.7202 4.32698 19.362C4.6146 19.9265 5.07354 20.3854 5.63803 20.673C6.27976 21 7.11984 21 8.8 21Z" 
                stroke="currentColor" 
                strokeWidth="2" 
                strokeLinecap="round" 
                strokeLinejoin="round"
              />
            </svg>
          </div>
          <h1 className="text-[28px] font-medium tracking-tight">Unlock Still</h1>
          <p className="text-[#151515]/60 mt-2 text-[15px]">
            Enter your password to access your secrets
          </p>
        </div>

        <div className="space-y-4">
          <div>
            <div className="text-xs uppercase tracking-[1.5px] text-[#151515]/50 mb-2 font-medium">
              {usePin ? 'PIN' : 'MASTER PASSWORD'}
            </div>
            <input
              type={usePin ? 'text' : 'password'}
              value={input}
              onChange={(e) => setInput(e.target.value)}
              onKeyDown={handleKeyDown}
              placeholder={usePin ? 'Enter your PIN' : 'Enter your password'}
              className="w-full bg-white border border-black/10 focus:border-black/30 rounded-[14px] px-5 py-4 text-[17px] placeholder:text-[#151515]/40 focus:outline-none transition-all"
              autoFocus
            />
          </div>

          {error && (
            <div className="text-red-600 text-sm text-center">{error}</div>
          )}

          <button
            onClick={handleUnlock}
            disabled={!input.trim() || isLoading}
            className="w-full py-4 bg-[#151515] text-white text-sm font-medium rounded-[14px] disabled:opacity-50 transition-all active:scale-[0.985]"
          >
            {isLoading ? 'Unlocking...' : 'Unlock'}
          </button>

          {hasPin && (
            <div className="text-center">
              <button
                onClick={() => {
                  setUsePin(!usePin)
                  setInput('')
                  setError('')
                }}
                className="text-xs text-[#151515]/60 hover:text-[#151515] underline"
              >
                {usePin ? 'Use password instead' : 'Use PIN instead'}
              </button>
            </div>
          )}
        </div>

        <div className="mt-8 text-center text-[11px] text-[#151515]/40">
          Your secrets are encrypted with Argon2id.<br />
          Nothing leaves this device.
        </div>
      </div>
    </div>
  )
}