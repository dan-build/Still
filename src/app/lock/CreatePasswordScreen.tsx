import { useState, type FormEvent } from 'react'
import { Button } from '@/shared/ui/Button'
import { TextField } from '@/shared/ui/TextField'
import LockLayout from './LockLayout'

interface CreatePasswordScreenProps {
  onCreate: (password: string) => Promise<void>
}

const MIN_LENGTH = 8

export default function CreatePasswordScreen({ onCreate }: CreatePasswordScreenProps) {
  const [password, setPassword] = useState('')
  const [confirmPassword, setConfirmPassword] = useState('')
  const [confirmLeft, setConfirmLeft] = useState(false)
  const [error, setError] = useState('')
  const [isLoading, setIsLoading] = useState(false)

  // Problems show as soon as they're certain, not only on submit.
  const onlySpaces = password.length > 0 && password.trim() === ''
  const tooShort = password.length < MIN_LENGTH
  // A mismatch is certain once the confirmation is as long as the password,
  // or once the person has left the field; before that they're still typing.
  const mismatch =
    confirmPassword.length > 0 && confirmPassword !== password && (confirmLeft || confirmPassword.length >= password.length)
  const valid = !tooShort && !onlySpaces && confirmPassword === password

  const handleCreate = async (e: FormEvent) => {
    e.preventDefault()
    if (!valid || isLoading) return
    setError('')
    setIsLoading(true)
    try {
      await onCreate(password)
    } catch {
      setError("Couldn't create the vault. Nothing was saved. Please try again.")
      setIsLoading(false)
    }
  }

  return (
    <LockLayout
      title="Create your vault"
      width={340}
      breathing={isLoading}
      footer={
        error ? (
          <span role="alert" className="text-danger">
            {error}
          </span>
        ) : isLoading ? (
          <span aria-live="polite">Creating your vault…</span>
        ) : null
      }
      actions={
        <form onSubmit={handleCreate} className="flex flex-col gap-4">
          <TextField
            label="Master password"
            revealable
            autoComplete="new-password"
            spellCheck={false}
            // The screen's only task is this field, as in any app's first run.
            // eslint-disable-next-line jsx-a11y/no-autofocus
            autoFocus
            value={password}
            disabled={isLoading}
            onChange={(e) => setPassword(e.target.value)}
            hint="At least 8 characters. A few unrelated words work well."
            error={onlySpaces ? "A password can't be only spaces." : undefined}
          />
          <TextField
            label="Confirm password"
            revealable
            autoComplete="new-password"
            spellCheck={false}
            value={confirmPassword}
            disabled={isLoading}
            onChange={(e) => setConfirmPassword(e.target.value)}
            onBlur={() => setConfirmLeft(true)}
            error={mismatch ? "The passwords don't match." : undefined}
          />
          <Button type="submit" variant="primary" size="md" block disabled={!valid || isLoading} className="mt-1">
            Create vault
          </Button>
        </form>
      }
    >
      <p>Choose a master password. It can’t be recovered if you forget it, so keep a copy somewhere safe.</p>
    </LockLayout>
  )
}
