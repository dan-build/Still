import { useRef, useState, type FormEvent, type KeyboardEvent } from 'react'
import type { NewItem } from '@/features/vault/model/types'
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

interface SecretDialogProps {
  open: boolean
  onClose: () => void
  /**
   * The secret being edited. Without it the dialog adds a new one. When
   * editing, the value starts empty and is only sent if a new one is typed,
   * so the current secret is never decrypted into the page to edit a label.
   * The caller keys the dialog by the secret, so its fields start fresh.
   */
  editing?: { label: string; type: ItemType }
  /** Saves the secret; throws if it couldn't be saved. */
  onSave: (secret: { label: string; type: ItemType; value?: string }) => Promise<void>
  /** Reports a save that failed. */
  onFailed: () => void
}

/** Add secret, or Edit secret: one dialog, as on the approved mockup. */
export default function SecretDialog({ open, onClose, editing, onSave, onFailed }: SecretDialogProps) {
  const [type, setType] = useState<ItemType>(editing?.type ?? 'password')
  const [label, setLabel] = useState(editing?.label ?? '')
  const [value, setValue] = useState('')
  const [saving, setSaving] = useState(false)
  const labelField = useRef<HTMLInputElement>(null)

  const onlyBlank = value !== '' && value.trim() === ''
  const edgeSpace = value.trim() !== '' && value !== value.trim()
  // Adding needs a value; editing may keep the current one.
  const ready = label.trim() !== '' && (editing ? !onlyBlank : value.trim() !== '') && !saving
  const formId = editing ? 'edit-secret' : 'add-secret'

  const reset = () => {
    setLabel(editing?.label ?? '')
    setValue('')
    setType(editing?.type ?? 'password')
  }

  const close = () => {
    if (saving) return
    reset()
    onClose()
  }

  const submit = async (e?: FormEvent) => {
    e?.preventDefault()
    if (!ready) return
    setSaving(true)
    try {
      // The value is stored exactly as typed; only the label is trimmed.
      // An empty value while editing keeps the current one.
      await onSave({ label: label.trim(), type, value: editing && value === '' ? undefined : value })
    } catch {
      setSaving(false)
      onFailed()
      return
    }
    setSaving(false)
    reset()
    onClose()
  }

  // ⌘↵ adds from either field, including the multi-line value.
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
      title={editing ? 'Edit secret' : 'Add secret'}
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
          <Button variant="primary" type="submit" form={formId} disabled={!ready}>
            {editing ? (saving ? 'Saving…' : 'Save') : saving ? 'Adding…' : 'Add secret'}
          </Button>
        </>
      }
    >
      <form id={formId} onSubmit={submit} className="flex flex-col gap-4">
        <SegmentedControl label="Type" options={TYPES} value={type} onChange={setType} />
        <TextField
          ref={labelField}
          label="Label"
          placeholder="What is this for?"
          onKeyDown={onKeyDown}
          value={label}
          onChange={(e) => setLabel(e.target.value)}
        />
        <TextField
          label={editing ? 'New value' : 'Value'}
          multiline
          // Passwords and keys are masked as you type, notes are not.
          revealable={type !== 'note'}
          mono={type !== 'note'}
          rows={type === 'note' ? 4 : 1}
          spellCheck={false}
          autoComplete="off"
          autoCorrect="off"
          autoCapitalize="off"
          placeholder={editing ? 'Leave empty to keep the current value' : 'Paste or type the secret here…'}
          onKeyDown={onKeyDown}
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
            ) : editing ? (
              'The current value stays hidden. Type a new one only to replace it.'
            ) : (
              'Kept exactly as typed, including spaces.'
            )
          }
        />
      </form>
    </Dialog>
  )
}
