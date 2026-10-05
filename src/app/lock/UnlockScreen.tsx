import { useRef, useState, type FormEvent } from 'react'
import { Icon } from '@/shared/ui/Icon'
import { TextField } from '@/shared/ui/TextField'
import LockLayout from './LockLayout'

export type UnlockOutcome = 'ok' | 'wrong-password' | 'unreadable-data' | 'failed'

interface UnlockScreenProps {
  onUnlock: (password: string) => Promise<UnlockOutcome>
}

const MESSAGES: Record<Exclude<UnlockOutcome, 'ok'>, string> = {
  'wrong-password': 'Incorrect password. Try again.',
  'unreadable-data': "Still couldn't read this vault's data. Nothing was changed.",
  failed: 'Unlocking failed. Nothing was changed. Close other apps to free memory, then try again.',
}

export default function UnlockScreen({ onUnlock }: UnlockScreenProps) {
  const [input, setInput] = useState('')
  const [error, setError] = useState('')
  const [isLoading, setIsLoading] = useState(false)
  const field = useRef<HTMLInputElement>(null)

  const handleUnlock = async (e: FormEvent) => {
    e.preventDefault()
    // Only empty input is blocked: a password may be made of spaces.
    if (input.length === 0 || isLoading) return

    setIsLoading(true)
    setError('')
    let outcome: UnlockOutcome
    try {
      outcome = await onUnlock(input)
    } catch {
      outcome = 'failed'
    }
    setIsLoading(false)
    if (outcome === 'ok') return
    setError(MESSAGES[outcome])
    if (outcome === 'wrong-password') setInput('')
    // The field was disabled while unlocking; put the cursor back in it.
    requestAnimationFrame(() => field.current?.focus())
  }

  const ready = input.length > 0
  const footer = error ? (
    <span id="unlock-error" role="alert" className="flex items-center gap-1.5 text-danger">
      <Icon name="warning" />
      {error}
    </span>
  ) : (
    <span aria-live="polite" className="flex items-center gap-1.5">
      {isLoading ? (
        'Unlocking…'
      ) : ready ? (
        'Press Return to unlock'
      ) : (
        <>
          <Icon name="lock" />
          Encrypted on this device. Nothing leaves it.
        </>
      )}
    </span>
  )

  return (
    <LockLayout title="Unlock Still" breathing={isLoading} footer={footer} actions={
      <form onSubmit={handleUnlock}>
        <TextField
          ref={field}
          label="Master password"
          labelHidden
          large
          type="password"
          autoComplete="current-password"
          spellCheck={false}
          autoFocus
          placeholder="Master password"
          value={input}
          disabled={isLoading}
          onChange={(e) => setInput(e.target.value)}
          invalid={Boolean(error)}
          aria-describedby={error ? 'unlock-error' : undefined}
          trailing={
            <button
              type="submit"
              aria-label="Unlock"
              disabled={!ready || isLoading}
              className={[
                'focus-ring mr-1 inline-flex size-7 shrink-0 items-center justify-center rounded-4',
                'transition-[background-color,color] duration-150',
                ready ? 'bg-accent-fill text-on-accent' : 'text-g5',
              ].join(' ')}
            >
              <Icon name="arrow-right" />
            </button>
          }
        />
      </form>
    }>
      <p>Enter your master password.</p>
    </LockLayout>
  )
}
