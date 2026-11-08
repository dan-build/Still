import { useState } from 'react'
import type { KeptCopy } from '@/features/vault/model/types'
import { Button } from '@/shared/ui/Button'
import { Dialog } from '@/shared/ui/Dialog'

interface KeptCopiesDialogProps {
  /** The kept copies, or null while closed. */
  copies: KeptCopy[] | null
  onClose: () => void
  /** Moves one to the Trash; resolves with what's left. */
  onTrash: (name: string) => Promise<KeptCopy[]>
  onError: (message: string) => void
}

const WHY: Record<string, string> = {
  'vault-v1': 'From before the upgrade to the new format. Lens names and labels in it are readable.',
  'vault-bak': 'An earlier backup copy of your vault.',
  'vault-unreadable': "A vault file Still couldn't read.",
  'vault-before-restore': 'Your vault as it was before a backup was restored.',
}

const why = (name: string) => WHY[Object.keys(WHY).find((stem) => name.startsWith(stem)) ?? ''] ?? ''

/** The copies Still kept next to the vault, each of which can be moved to the Trash. */
export default function KeptCopiesDialog({ copies, onClose, onTrash, onError }: KeptCopiesDialogProps) {
  const [list, setList] = useState<KeptCopy[] | null>(null)
  const [trashing, setTrashing] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const shown = list ?? copies ?? []

  const close = () => {
    if (busy) return
    setList(null)
    setTrashing(null)
    onClose()
  }

  const trash = async () => {
    if (!trashing) return
    setBusy(true)
    try {
      setList(await onTrash(trashing))
    } catch {
      onError(`Couldn't move ${trashing} to the Trash.`)
    } finally {
      setBusy(false)
      setTrashing(null)
    }
  }

  if (trashing) {
    return (
      <Dialog
        open
        onClose={() => !busy && setTrashing(null)}
        dismissible={!busy}
        width={400}
        title={`Move ${trashing} to the Trash?`}
        description="You can still recover it from the Trash until you empty it. If you're unsure, save a backup of your vault first."
        footer={
          <>
            <Button variant="ghost" onClick={() => setTrashing(null)} disabled={busy}>
              Cancel
            </Button>
            <Button variant="danger" onClick={trash} disabled={busy}>
              Move to Trash
            </Button>
          </>
        }
      />
    )
  }

  return (
    <Dialog
      open={copies !== null}
      onClose={close}
      width={460}
      title="Kept copies"
      description="Copies Still kept next to your vault, in case they were ever needed. Still never removes them by itself."
      footer={
        <Button variant="primary" onClick={close}>
          Done
        </Button>
      }
    >
      {shown.length === 0 ? (
        <p className="text-13 text-g3">There are no kept copies.</p>
      ) : (
        <ul aria-label="Kept copies" className="flex flex-col gap-3">
          {shown.map((copy) => (
            <li key={copy.name} className="flex items-start gap-3">
              <div className="min-w-0 flex-1">
                <p className="truncate font-mono text-12 text-g1">{copy.name}</p>
                <p className="text-12 leading-[1.4] text-g4">
                  {why(copy.name)} Saved {new Date(copy.modifiedAt).toLocaleDateString()}.
                </p>
              </div>
              <Button onClick={() => setTrashing(copy.name)} aria-label={`Move ${copy.name} to the Trash`}>
                Move to Trash
              </Button>
            </li>
          ))}
        </ul>
      )}
    </Dialog>
  )
}
