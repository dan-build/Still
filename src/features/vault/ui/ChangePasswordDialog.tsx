import { useRef, useState, type FormEvent } from 'react'
import { VaultApiError } from '@/platform/tauri/vaultApi'
import { Button } from '@/shared/ui/Button'
import { Dialog } from '@/shared/ui/Dialog'
import { SegmentedControl } from '@/shared/ui/SegmentedControl'
import { TextField } from '@/shared/ui/TextField'

const MIN_LENGTH = 8

type Strength = 'standard' | 'stronger'

interface ChangePasswordDialogProps {
  open: boolean
  onClose: () => void
  /** Changes the password; resolves with the kept copies that still open with the old one. */
  onChange: (current: string, next: string, stronger: boolean) => Promise<string[]>
  /** The password was changed and nothing is left to say. */
  onChanged: () => void
}

const STRENGTH_HINTS: Record<Strength, string> = {
  standard: 'Unlocking takes a few seconds, as it does now.',
  stronger: 'Unlocking takes about twice as long, and so does every guess at your password.',
}

/** What a refused change means, by the command's code. */
function failure(error: unknown): { current?: string; form?: string } {
  const code = error instanceof VaultApiError ? error.code : 'failed'
  switch (code) {
    case 'crypto-wrong-password':
      return { current: 'Incorrect password.' }
    case 'needs-upgrade':
      return { form: 'Your vault is still in the old format. Lock Still and unlock it again to upgrade it, then change the password.' }
    case 'write-failed':
      return { form: "Couldn't save the new password. Your password is unchanged. Please try again." }
    default:
      return { form: "Couldn't change the password. It's unchanged. Please try again." }
  }
}

/**
 * Change the master password: the current one, the new one twice, and how
 * hard it should be to guess. The secrets stay as they are; only the
 * password that unlocks them changes.
 */
export default function ChangePasswordDialog({ open, onClose, onChange, onChanged }: ChangePasswordDialogProps) {
  const [current, setCurrent] = useState('')
  const [next, setNext] = useState('')
  const [confirm, setConfirm] = useState('')
  const [confirmLeft, setConfirmLeft] = useState(false)
  const [strength, setStrength] = useState<Strength>('standard')
  const [errors, setErrors] = useState<{ current?: string; form?: string }>({})
  const [saving, setSaving] = useState(false)
  /** After a change: kept copies that still open with the old password. */
  const [olderCopies, setOlderCopies] = useState<string[] | null>(null)
  const firstField = useRef<HTMLInputElement>(null)

  // The same rules as a new vault's, shown as soon as they're certain.
  const onlySpaces = next.length > 0 && next.trim() === ''
  const tooShort = next.length < MIN_LENGTH
  const mismatch = confirm.length > 0 && confirm !== next && (confirmLeft || confirm.length >= next.length)
  const valid = current.length > 0 && !tooShort && !onlySpaces && confirm === next

  const reset = () => {
    setCurrent('')
    setNext('')
    setConfirm('')
    setConfirmLeft(false)
    setStrength('standard')
    setErrors({})
    setOlderCopies(null)
  }

  const close = () => {
    if (saving) return
    reset()
    onClose()
  }

  const submit = async (e: FormEvent) => {
    e.preventDefault()
    if (!valid || saving) return
    setErrors({})
    setSaving(true)
    try {
      const kept = await onChange(current, next, strength === 'stronger')
      setSaving(false)
      if (kept.length > 0) {
        setOlderCopies(kept)
      } else {
        reset()
        onChanged()
      }
    } catch (error) {
      setSaving(false)
      setErrors(failure(error))
    }
  }

  if (olderCopies) {
    return (
      <Dialog
        open={open}
        onClose={() => {
          reset()
          onChanged()
        }}
        width={420}
        title="Master password changed"
        footer={
          <Button
            variant="primary"
            onClick={() => {
              reset()
              onChanged()
            }}
          >
            OK
          </Button>
        }
      >
        <div className="flex flex-col gap-2 text-13 leading-[1.5] text-g3">
          <p>Still kept older copies of your vault that still open with your old password:</p>
          <ul className="list-disc pl-5 font-mono text-12 text-g2">
            {olderCopies.map((name) => (
              <li key={name}>{name}</li>
            ))}
          </ul>
          <p>They're in Still's app data folder. If your old password may be known to someone else, delete them yourself.</p>
        </div>
      </Dialog>
    )
  }

  return (
    <Dialog
      open={open}
      onClose={close}
      dismissible={!saving}
      width={400}
      title="Change master password"
      description="Your secrets stay as they are. Only the password that unlocks them changes."
      initialFocus={firstField}
      footerStart={saving ? <span className="text-12 text-g4">This takes a few seconds.</span> : undefined}
      footer={
        <>
          <Button variant="ghost" onClick={close} disabled={saving}>
            Cancel
          </Button>
          <Button variant="primary" type="submit" form="change-password" disabled={!valid || saving}>
            {saving ? 'Changing…' : 'Change password'}
          </Button>
        </>
      }
    >
      <form id="change-password" onSubmit={submit} className="flex flex-col gap-4">
        <TextField
          ref={firstField}
          label="Current password"
          type="password"
          autoComplete="current-password"
          spellCheck={false}
          value={current}
          error={errors.current}
          disabled={saving}
          onChange={(e) => setCurrent(e.target.value)}
        />
        <TextField
          label="New password"
          revealable
          autoComplete="new-password"
          spellCheck={false}
          hint="At least 8 characters. A few unrelated words work well."
          error={onlySpaces ? "A password can't be only spaces." : undefined}
          value={next}
          disabled={saving}
          onChange={(e) => setNext(e.target.value)}
        />
        <TextField
          label="Confirm new password"
          type="password"
          autoComplete="new-password"
          spellCheck={false}
          error={mismatch ? "The passwords don't match." : undefined}
          value={confirm}
          disabled={saving}
          onChange={(e) => setConfirm(e.target.value)}
          onBlur={() => setConfirmLeft(true)}
        />
        <div className="flex flex-col gap-2">
          <SegmentedControl
            label="Security"
            options={[
              { value: 'standard', label: 'Standard' },
              { value: 'stronger', label: 'Stronger' },
            ]}
            value={strength}
            onChange={setStrength}
          />
          <p className="text-12 leading-[1.4] text-g4">{STRENGTH_HINTS[strength]}</p>
        </div>
        {errors.form && (
          <p role="alert" className="text-12 leading-[1.4] text-danger">
            {errors.form}
          </p>
        )}
      </form>
    </Dialog>
  )
}
