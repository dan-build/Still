import { useEffect, useRef, useState } from 'react'
import type { ItemView, LensView as Lens, NewItem } from '@/platform/storage/backend'
import { Button } from '@/shared/ui/Button'
import { Dialog } from '@/shared/ui/Dialog'
import { Icon } from '@/shared/ui/Icon'
import { Menu } from '@/shared/ui/Menu'
import type { ToastMessage } from '@/shared/ui/Toast'
import AddSecretDialog from './AddSecretDialog'
import SecretRow from './SecretRow'

/** How long the copy icon shows its check. */
const COPIED_MS = 2000

interface LensViewProps {
  lens: Lens
  onAddItem: (item: NewItem) => Promise<void>
  onRevealItem: (itemId: string) => Promise<string>
  onCopyItem: (itemId: string) => Promise<void>
  onDeleteItem: (itemId: string) => Promise<void>
  onToast: (toast: ToastMessage) => void
  onForget: () => void
}

/** The selected Lens: its secrets as rows, with Add secret and the Lens's actions. */
export default function LensView({ lens, onAddItem, onRevealItem, onCopyItem, onDeleteItem, onToast, onForget }: LensViewProps) {
  const [revealed, setRevealed] = useState<Record<string, string>>({})
  const [busy, setBusy] = useState<string | null>(null)
  const [copied, setCopied] = useState<string | null>(null)
  const [adding, setAdding] = useState(false)
  const [forgetting, setForgetting] = useState(false)
  // The secret being deleted stays set while its dialog plays its exit, so
  // the title doesn't go blank; deleteOpen says whether it's open.
  const [deleting, setDeleting] = useState<ItemView | null>(null)
  const [deleteOpen, setDeleteOpen] = useState(false)
  const copiedTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)

  // Another Lens: nothing revealed carries over.
  useEffect(() => {
    setRevealed({})
    setCopied(null)
  }, [lens.id])
  useEffect(() => () => clearTimeout(copiedTimer.current), [])

  const toggleReveal = async (item: ItemView) => {
    if (revealed[item.id] !== undefined) {
      const { [item.id]: _, ...rest } = revealed
      setRevealed(rest)
      return
    }
    setBusy(item.id)
    try {
      const plaintext = await onRevealItem(item.id)
      setRevealed((prev) => ({ ...prev, [item.id]: plaintext }))
    } catch {
      onToast({ message: "Couldn't reveal the secret.", tone: 'error' })
    } finally {
      setBusy(null)
    }
  }

  const copy = async (item: ItemView) => {
    setBusy(item.id)
    try {
      // Rust puts the value on the clipboard; it never comes back to this page.
      await onCopyItem(item.id)
    } catch {
      onToast({ message: "Couldn't copy the secret.", tone: 'error' })
      return
    } finally {
      setBusy(null)
    }
    clearTimeout(copiedTimer.current)
    setCopied(item.id)
    copiedTimer.current = setTimeout(() => setCopied(null), COPIED_MS)
    onToast({ message: `${item.label} copied`, detail: 'Clears in 30 s', countdown: 30 })
  }

  const confirmDelete = async () => {
    const item = deleting
    if (!item) return
    setDeleteOpen(false)
    try {
      await onDeleteItem(item.id)
    } catch {
      onToast({ message: "Couldn't delete the secret. Nothing was changed.", tone: 'error' })
      return
    }
    const { [item.id]: _, ...rest } = revealed
    setRevealed(rest)
    onToast({ message: 'Secret deleted' })
  }

  const count = lens.items.length
  return (
    <section aria-labelledby="lens-title" className="flex min-h-0 flex-1 flex-col">
      {/* Part of the title strip: it drags the window; the text lets presses through. */}
      <header data-tauri-drag-region className="flex h-[52px] shrink-0 items-center gap-2 border-b border-hairline pr-4 pl-6">
        <h1 id="lens-title" className="pointer-events-none truncate text-14 font-semibold tracking-[-0.005em]">
          {lens.name}
        </h1>
        <span className="pointer-events-none shrink-0 text-13 text-g4 tabular-nums">{count === 0 ? 'Empty' : `${count} ${count === 1 ? 'secret' : 'secrets'}`}</span>
        <span className="pointer-events-none flex-1" />
        <Menu label="Lens actions" items={[{ label: 'Forget Lens', icon: 'trash', danger: true, onSelect: () => setForgetting(true) }]} />
        <Button variant="primary" icon="plus" onClick={() => setAdding(true)}>
          Add secret
        </Button>
      </header>

      {count === 0 ? (
        <div className="flex flex-1 flex-col items-center justify-center gap-2 pb-10 text-center">
          <div className="mb-2 flex size-10 items-center justify-center rounded-8 bg-sidebar text-g4 shadow-[inset_0_0_0_1px_var(--hairline)]">
            <Icon name="lens" />
          </div>
          <h2 className="text-14 font-semibold">No secrets yet</h2>
          <p className="mb-3 max-w-[300px] text-13 leading-[1.5] text-g3">
            Add a password, API key or note. It’s encrypted on this device before it’s saved.
          </p>
          <Button variant="primary" size="md" icon="plus" onClick={() => setAdding(true)}>
            Add secret
          </Button>
        </div>
      ) : (
        <div className="min-h-0 flex-1 overflow-y-auto px-3 py-2">
          <ul aria-label={`Secrets in ${lens.name}`}>
            {lens.items.map((item) => (
              <SecretRow
                key={item.id}
                item={item}
                revealed={revealed[item.id]}
                copied={copied === item.id}
                busy={busy === item.id}
                onReveal={() => toggleReveal(item)}
                onCopy={() => copy(item)}
                onDelete={() => {
                  setDeleting(item)
                  setDeleteOpen(true)
                }}
              />
            ))}
          </ul>
        </div>
      )}

      <AddSecretDialog
        open={adding}
        onClose={() => setAdding(false)}
        onAdd={async (item) => {
          await onAddItem(item)
          onToast({ message: 'Secret added' })
        }}
        onFailed={() => onToast({ message: "Couldn't save the secret. Nothing was changed.", tone: 'error' })}
      />

      <Dialog
        open={forgetting}
        onClose={() => setForgetting(false)}
        width={380}
        title={`Forget “${lens.name}”?`}
        description={`It moves to Archive with its ${count === 1 ? '1 secret' : `${count} secrets`}. You can restore it for 7 days; after that it’s deleted for good.`}
        footer={
          <>
            <Button variant="ghost" onClick={() => setForgetting(false)}>
              Cancel
            </Button>
            <Button
              variant="danger"
              onClick={() => {
                setForgetting(false)
                onForget()
              }}
            >
              Forget Lens
            </Button>
          </>
        }
      />

      <Dialog
        open={deleteOpen}
        onClose={() => setDeleteOpen(false)}
        width={380}
        title={`Delete “${deleting?.label ?? ''}”?`}
        description="This can’t be undone. The secret is deleted from this Lens right away."
        footer={
          <>
            <Button variant="ghost" onClick={() => setDeleteOpen(false)}>
              Cancel
            </Button>
            <Button variant="danger" onClick={confirmDelete}>
              Delete secret
            </Button>
          </>
        }
      />
    </section>
  )
}
