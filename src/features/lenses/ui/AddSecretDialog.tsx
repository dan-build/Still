import { useRef, useState, type FormEvent, type KeyboardEvent } from 'react'
import type { NewItem } from '@/platform/storage/backend'
import { Button } from '@/shared/ui/Button'
import { Dialog } from '@/shared/ui/Dialog'
import { Kbd } from '@/shared/ui/Kbd'
import { SegmentedControl } from '@/shared/ui/SegmentedControl'
import { TextField } from '@/shared/ui/TextField'

type ItemType = NewItem['type']

const TYPES = [
  { value: 'password', label: 'Password', icon: 'password' },
  { value: 'key', label: 'API key', icon: 'key' },
  { value: 'note', label: 'Note', icon: 'note' },
] as const

interface AddSecretDialogProps {
  open: boolean
  onClose: () => void
  /** Saves the secret; throws if it couldn't be saved. */
  onAdd: (item: NewItem) => Promise<void>
  /** Reports a save that failed. */
  onFailed: () => void
}

export default function AddSecretDialog({ open, onClose, onAdd, onFailed }: AddSecretDialogProps) {
  const [type, setType] = useState<ItemType>('password')
  const [label, setLabel] = useState('')
  const [value, setValue] = useState('')
  const [saving, setSaving] = useState(false)
  const labelField = useRef<HTMLInputElement>(null)

  const onlyBlank = value !== '' && value.trim() === ''
  const edgeSpace = value.trim() !== '' && value !== value.trim()
  const ready = label.trim() !== '' && value.trim() !== '' && !saving

  const close = () => {
    if (saving) return
    setLabel('')
    setValue('')
    setType('password')
    onClose()
  }

  const submit = async (e?: FormEvent) => {
    e?.preventDefault()
    if (!ready) return
    setSaving(true)
    try {
      // The value is stored exactly as typed; only the label is trimmed.
      await onAdd({ label: label.trim(), type, value })
    } catch {
      setSaving(false)
      onFailed()
      return
    }
    setSaving(false)
    setLabel('')
    setValue('')
    setType('password')
    onClose()
  }

  // ⌘↵ adds from anywhere in the form, including the multi-line value.
  const onKeyDown = (e: KeyboardEvent) => {
    if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
      e.preventDefault()
      void submit()
    }
  }

  return (
    <Dialog
      open={open}
      onClose={close}
      dismissible={!saving}
      title="Add secret"
      initialFocus={labelField}
      footerStart={
        <>
          <Kbd>⌘</Kbd>
          <Kbd>↵</Kbd>
        </>
      }
      footer={
        <>
          <Button variant="ghost" onClick={close} disabled={saving}>
            Cancel
          </Button>
          <Button variant="primary" type="submit" form="add-secret" disabled={!ready}>
            {saving ? 'Adding…' : 'Add secret'}
          </Button>
        </>
      }
    >
      <form id="add-secret" onSubmit={submit} onKeyDown={onKeyDown} className="flex flex-col gap-4">
        <SegmentedControl label="Type" options={TYPES} value={type} onChange={setType} />
        <TextField
          ref={labelField}
          label="Label"
          placeholder="What is this for?"
          value={label}
          onChange={(e) => setLabel(e.target.value)}
        />
        <TextField
          label="Value"
          multiline
          // Passwords and keys are masked as you type, notes are not.
          revealable={type !== 'note'}
          mono={type !== 'note'}
          rows={type === 'note' ? 4 : 1}
          spellCheck={false}
          autoComplete="off"
          autoCorrect="off"
          autoCapitalize="off"
          placeholder="Paste or type the secret here…"
          value={value}
          onChange={(e) => setValue(e.target.value)}
          error={onlyBlank ? "A secret can't be only spaces or line breaks." : undefined}
          hint={
            edgeSpace ? (
              <span className="flex items-start justify-between gap-3">
                <span>This secret starts or ends with a space or line break. It will be kept exactly as typed.</span>
                <button
                  type="button"
                  onClick={() => setValue(value.trim())}
                  className="focus-ring shrink-0 rounded-4 font-medium text-accent-text underline underline-offset-2"
                >
                  Remove them
                </button>
              </span>
            ) : (
              'Kept exactly as typed, including spaces.'
            )
          }
        />
      </form>
    </Dialog>
  )
}
