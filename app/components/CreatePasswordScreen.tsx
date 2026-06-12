'use client'

import { useState } from 'react'

interface CreatePasswordScreenProps {
  onCreate: (password: string, pin?: string) => Promise<void>
}

export default function CreatePasswordScreen({ onCreate }: CreatePasswordScreenProps) {
  const [password, setPassword] = useState('')
  const [confirmPassword, setConfirmPassword] = useState('')
  const [pin, setPin] = useState('')
  const [usePin, setUsePin] = useState(false)
  const [error, setError] = useState('')
  const [isLoading, setIsLoading] = useState(false)

  const handleCreate = async () => {
    setError('')

    if (password.length < 8) {
      setError('Password must be at least 8 characters')
      return
    }

    if (password !== confirmPassword) {
      setError('Passwords do not match')
      return
    }

    if (usePin && pin.length < 4) {
      setError('PIN must be at least 4 digits')
      return
    }

    setIsLoading(true)

    try {
      await onCreate(password, usePin ? pin : undefined)
    } catch (err) {
      setError('Failed to create password. Please try again.')
    } finally {
      setIsLoading(false)
    }
  }

  return (
    <div className="min-h-screen flex items-center justify-center bg-[#F8F9FA] px-6">
      <div className="w-full max-w-[420px]">
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
                d="M12 2.50011L11 5L13.5 8L11 11L13.5 14L11 17.5L12 21.5001M20 12.0001C20 16.9086 14.646 20.4785 12.698 21.615C12.4766 21.7442 12.3659 21.8087 12.2097 21.8422C12.0884 21.8682 11.9116 21.8682 11.7903 21.8422C11.6341 21.8087 11.5234 21.7442 11.302 21.615C9.35396 20.4785 4 16.9086 4 12.0001V7.21772C4 6.4182 4 6.01845 4.13076 5.67482C4.24627 5.37126 4.43398 5.10039 4.67766 4.88564C4.9535 4.64255 5.3278 4.50219 6.0764 4.22146L11.4382 2.21079C11.6461 2.13283 11.75 2.09385 11.857 2.07839C11.9518 2.06469 12.0482 2.06469 12.143 2.07839C12.25 2.09385 12.3539 2.13283 12.5618 2.21079L17.9236 4.22146C18.6722 4.50219 19.0465 4.64255 19.3223 4.88564C19.566 5.10039 19.7537 5.37126 19.8692 5.67482C20 6.01845 20 6.4182 20 7.21772V12.0001Z" 
                stroke="currentColor" 
                strokeWidth="2" 
                strokeLinecap="round" 
                strokeLinejoin="round"
              />
            </svg>
          </div>
          <h1 className="text-[28px] font-medium tracking-tight">Create Master Password</h1>
          <p className="text-[#151515]/60 mt-3 text-[15px] leading-relaxed">
            This password protects all your secrets.<br />
            It cannot be recovered if forgotten.
          </p>
        </div>

        <div className="space-y-5">
          <div>
            <div className="text-xs uppercase tracking-[1.5px] text-[#151515]/50 mb-2 font-medium">MASTER PASSWORD</div>
            <input
              type="password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              placeholder="Create a strong password"
              className="w-full bg-white border border-black/10 focus:border-black/30 rounded-[14px] px-5 py-4 text-[17px] placeholder:text-[#151515]/40 focus:outline-none"
            />
          </div>

          <div>
            <div className="text-xs uppercase tracking-[1.5px] text-[#151515]/50 mb-2 font-medium">CONFIRM PASSWORD</div>
            <input
              type="password"
              value={confirmPassword}
              onChange={(e) => setConfirmPassword(e.target.value)}
              placeholder="Confirm your password"
              className="w-full bg-white border border-black/10 focus:border-black/30 rounded-[14px] px-5 py-4 text-[17px] placeholder:text-[#151515]/40 focus:outline-none"
            />
          </div>

          {/* Optional PIN */}
          <div className="pt-2">
            <div className="flex items-center justify-between mb-2">
              <div className="text-xs uppercase tracking-[1.5px] text-[#151515]/50 font-medium">OPTIONAL PIN</div>
              <button
                onClick={() => setUsePin(!usePin)}
                className="text-xs text-[#151515]/60 hover:text-[#151515]"
              >
                {usePin ? 'Remove PIN' : 'Add PIN'}
              </button>
            </div>

            {usePin && (
              <input
                type="text"
                value={pin}
                onChange={(e) => setPin(e.target.value.replace(/\D/g, ''))}
                maxLength={8}
                placeholder="6-digit PIN (optional)"
                className="w-full bg-white border border-black/10 focus:border-black/30 rounded-[14px] px-5 py-4 text-[17px] placeholder:text-[#151515]/40 focus:outline-none"
              />
            )}
          </div>

          {error && (
            <div className="text-red-600 text-sm text-center py-1">{error}</div>
          )}

          <div className="pt-4">
            <button
              onClick={handleCreate}
              disabled={!password || !confirmPassword || isLoading}
              className="w-full py-4 bg-[#151515] text-white text-sm font-medium rounded-[14px] disabled:opacity-50 transition-all active:scale-[0.985]"
            >
              {isLoading ? 'Creating Secure Vault...' : 'Create Secure Vault'}
            </button>
          </div>

          <div className="text-center text-[11px] text-[#151515]/50 pt-2">
            We recommend using a strong password.<br />
            PIN is optional and less secure.
          </div>
        </div>
      </div>
    </div>
  )
}