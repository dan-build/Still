import { useRef, useState, type FormEvent } from 'react'
import { Button } from '@/shared/ui/Button'
import { Dialog } from '@/shared/ui/Dialog'
import { TextField } from '@/shared/ui/TextField'

interface NewLensDialogProps {
  open: boolean
  onClose: () => void
  /** Creates the Lens; resolves false if it couldn't be saved (the caller says so). */
  onCreate: (name: string) => Promise<boolean>
}

export default function NewLensDialog({ open, onClose, onCreate }: NewLensDialogProps) {
  const [name, setName] = useState('')
  const [saving, setSaving] = useState(false)
  const field = useRef<HTMLInputElement>(null)

  const close = () => {
    if (saving) return
    setName('')
    onClose()
  }

  const submit = async (e: FormEvent) => {
    e.preventDefault()
    if (!name.trim() || saving) return
    setSaving(true)
    const created = await onCreate(name)
    setSaving(false)
    if (created) setName('')
  }

  return (
    <Dialog
      open={open}
      onClose={close}
      dismissible={!saving}
      width={360}
      title="New Lens"
      description="A Lens is an encrypted collection with its own key."
      initialFocus={field}
      footer={
        <>
          <Button variant="ghost" onClick={close} disabled={saving}>
            Cancel
          </Button>
          <Button variant="primary" type="submit" form="new-lens" disabled={!name.trim() || saving}>
            Create Lens
          </Button>
        </>
      }
    >
      <form id="new-lens" onSubmit={submit}>
        <TextField ref={field} label="Name" placeholder="e.g. Banking Keys" value={name} onChange={(e) => setName(e.target.value)} />
      </form>
    </Dialog>
  )
}
