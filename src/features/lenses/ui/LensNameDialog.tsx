import { useRef, useState, type FormEvent } from 'react'
import { Button } from '@/shared/ui/Button'
import { Dialog } from '@/shared/ui/Dialog'
import { TextField } from '@/shared/ui/TextField'

interface LensNameDialogProps {
  open: boolean
  onClose: () => void
  /** The Lens's current name, when renaming; without it the dialog creates a Lens. */
  renaming?: string
  /** Saves the name; resolves false if it couldn't be saved (the caller says so). */
  onSubmit: (name: string) => Promise<boolean>
}

/** New Lens, or Rename Lens: the same small dialog. */
export default function LensNameDialog({ open, onClose, renaming, onSubmit }: LensNameDialogProps) {
  const [name, setName] = useState(renaming ?? '')
  const [saving, setSaving] = useState(false)
  const field = useRef<HTMLInputElement>(null)
  const formId = renaming ? 'rename-lens' : 'new-lens'

  const close = () => {
    if (saving) return
    setName(renaming ?? '')
    onClose()
  }

  const submit = async (e: FormEvent) => {
    e.preventDefault()
    if (!name.trim() || saving) return
    setSaving(true)
    const saved = await onSubmit(name)
    setSaving(false)
    if (saved && !renaming) setName('')
  }

  return (
    <Dialog
      open={open}
      onClose={close}
      dismissible={!saving}
      width={360}
      title={renaming ? 'Rename Lens' : 'New Lens'}
      description={renaming ? undefined : 'A Lens is an encrypted collection with its own key.'}
      initialFocus={field}
      footer={
        <>
          <Button variant="ghost" onClick={close} disabled={saving}>
            Cancel
          </Button>
          <Button variant="primary" type="submit" form={formId} disabled={!name.trim() || saving}>
            {renaming ? 'Save' : 'Create Lens'}
          </Button>
        </>
      }
    >
      <form id={formId} onSubmit={submit}>
        <TextField ref={field} label="Name" placeholder="e.g. Banking Keys" value={name} onChange={(e) => setName(e.target.value)} />
      </form>
    </Dialog>
  )
}
