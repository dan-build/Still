import { useEffect, useRef, useState } from 'react'
import type { GeneratedPassword, PasswordStrength } from '@/features/vault/model/types'
import { Button } from '@/shared/ui/Button'
import { SegmentedControl } from '@/shared/ui/SegmentedControl'
import { TextField } from '@/shared/ui/TextField'

/** Rust's help with a new master password: a passphrase, and a rating of a typed one. */
export interface PasswordHelp {
  suggest: (words: number) => Promise<GeneratedPassword>
  rate: (password: string) => Promise<PasswordStrength>
}

const WORD_COUNTS = ['4', '5', '6', '7', '8'] as const
/** How long typing must pause before the password is rated. */
const RATE_AFTER_MS = 300
const WORDS = ['Weak', 'Weak', 'Fair', 'Good', 'Strong'] as const

interface NewPasswordFieldsProps {
  /** "Master password" when creating a vault, "New password" when changing it. */
  label: string
  confirmLabel: string
  password: string
  confirm: string
  onPassword: (password: string) => void
  onConfirm: (confirm: string) => void
  /** The confirmation was left (blurred): a mismatch is then certain. */
  onConfirmLeft: () => void
  /** Errors for the two fields, decided by the screen. */
  passwordError?: string
  confirmError?: string
  disabled?: boolean
  help?: PasswordHelp
  /** Focus the password field on mount (the create screen's only task). */
  focusFirst?: boolean
}

/**
 * The new master password and its confirmation, with a passphrase Rust can
 * suggest (shown in full, to write down) and a rating of what's typed. The
 * rating is advice only: the screen decides what it accepts.
 */
export default function NewPasswordFields({
  label,
  confirmLabel,
  password,
  confirm,
  onPassword,
  onConfirm,
  onConfirmLeft,
  passwordError,
  confirmError,
  disabled,
  help,
  focusFirst,
}: NewPasswordFieldsProps) {
  const [words, setWords] = useState<(typeof WORD_COUNTS)[number]>('5')
  // The passphrase in the fields, while it's still there unchanged.
  const [suggested, setSuggested] = useState<string | null>(null)
  const [suggestFailed, setSuggestFailed] = useState(false)
  const [strength, setStrength] = useState<PasswordStrength | null>(null)
  const latest = useRef('')

  // Rates the password once typing pauses; a reply for older text is dropped.
  useEffect(() => {
    latest.current = password
    if (!help || password === '') return
    const timer = setTimeout(() => {
      help
        .rate(password)
        .then((rating) => {
          if (latest.current === password) setStrength(rating)
        })
        .catch(() => {})
    }, RATE_AFTER_MS)
    return () => clearTimeout(timer)
  }, [help, password])

  const suggest = async (count: string) => {
    if (!help) return
    try {
      const { value } = await help.suggest(Number(count))
      onPassword(value)
      onConfirm(value)
      setSuggested(value)
      setSuggestFailed(false)
    } catch {
      setSuggestFailed(true)
    }
  }

  const showSuggested = suggested !== null && suggested === password && suggested === confirm
  // The last rating stays while typing goes on, so the meter doesn't flicker.
  const rating = password !== '' ? strength : null
  const advice = rating && (rating.warning ?? (rating.score < 3 ? rating.suggestions[0] : undefined))

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-col gap-2">
        <TextField
          label={label}
          revealable
          autoComplete="new-password"
          spellCheck={false}
          // eslint-disable-next-line jsx-a11y/no-autofocus
          autoFocus={focusFirst}
          value={password}
          disabled={disabled}
          onChange={(e) => onPassword(e.target.value)}
          hint={rating ? undefined : 'At least 8 characters. A few unrelated words work well.'}
          error={passwordError}
        />
        {rating && <Meter score={rating.score} advice={advice ?? undefined} />}
      </div>
      <TextField
        label={confirmLabel}
        revealable
        autoComplete="new-password"
        spellCheck={false}
        value={confirm}
        disabled={disabled}
        onChange={(e) => onConfirm(e.target.value)}
        onBlur={onConfirmLeft}
        error={confirmError}
      />
      {help && (
        <div className="flex flex-col gap-2">
          {showSuggested ? (
            <div className="flex flex-col gap-2 rounded-8 bg-field p-3 shadow-[inset_0_0_0_1px_var(--hairline)]">
              <p className="text-12 font-medium text-g3">Your passphrase</p>
              <p className="font-mono text-13 break-all text-g1 select-text" data-testid="suggested-passphrase">
                {suggested}
              </p>
              <p className="text-12 leading-[1.4] text-g4">Write it down and keep it somewhere safe. It can’t be recovered if you forget it.</p>
              <div className="flex items-end justify-between gap-3">
                <SegmentedControl
                  label="Words"
                  options={WORD_COUNTS.map((count) => ({ value: count, label: count }))}
                  value={words}
                  onChange={(count) => {
                    setWords(count)
                    void suggest(count)
                  }}
                />
                <Button disabled={disabled} onClick={() => void suggest(words)}>
                  Another
                </Button>
              </div>
            </div>
          ) : (
            <Button variant="ghost" icon="dice" disabled={disabled} onClick={() => void suggest(words)} className="self-start">
              Suggest a passphrase
            </Button>
          )}
          {suggestFailed && (
            <p role="alert" className="text-12 text-danger">
              Couldn’t suggest a passphrase. Try again.
            </p>
          )}
        </div>
      )}
    </div>
  )
}

/** Four bars and a word, from zxcvbn's 0 to 4, with one piece of advice. */
function Meter({ score, advice }: { score: number; advice?: string }) {
  const filled = Math.max(1, score)
  return (
    <div className="flex flex-col gap-1.5" aria-live="polite">
      <div className="flex items-center gap-2">
        <div className="flex flex-1 gap-1" aria-hidden>
          {[1, 2, 3, 4].map((bar) => (
            <span key={bar} className={`h-1 flex-1 rounded-4 ${bar <= filled ? 'bg-g2' : 'bg-g6'}`} />
          ))}
        </div>
        <span className="w-12 text-right text-12 font-medium text-g2">{WORDS[score] ?? 'Weak'}</span>
      </div>
      <p className="text-12 leading-[1.4] text-g4">
        <span className="sr-only">Password strength: {WORDS[score] ?? 'Weak'}. </span>
        {advice ?? 'At least 8 characters. A few unrelated words work well.'}
      </p>
    </div>
  )
}
