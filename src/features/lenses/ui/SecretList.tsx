import { useEffect, useRef, useState } from 'react'
import type { ItemEdit, ItemView } from '@/features/vault/model/types'
import { Button } from '@/shared/ui/Button'
import { Dialog } from '@/shared/ui/Dialog'
import { Icon } from '@/shared/ui/Icon'
import type { ToastMessage } from '@/shared/ui/Toast'
import SecretDialog from './SecretDialog'
import SecretRow from './SecretRow'

/** How long the copy icon shows its check. */
const COPIED_MS = 2000

/** What the rows can do, by Lens and secret. */
export interface SecretOps {
  reveal: (lensId: string, itemId: string) => Promise<string>
  copy: (lensId: string, itemId: string) => Promise<void>
  update: (lensId: string, itemId: string, edit: ItemEdit) => Promise<void>
  remove: (lensId: string, itemId: string) => Promise<void>
}

interface Group {
  lens: { id: string; name: string }
  items: readonly ItemView[]
}

interface SecretListProps {
  groups: readonly Group[]
  /** Show each group's Lens above its rows (search results). */
  headings?: boolean
  /** Text to mark in the labels (the search). */
  highlight?: string
  /** Names the list for assistive technology when there are no headings. */
  label: string
  ops: SecretOps
  onToast: (toast: ToastMessage) => void
}

type Target = { lensId: string; item: ItemView }
const keyOf = (lensId: string, itemId: string) => `${lensId}\u0000${itemId}`

/**
 * Secrets as rows, with Reveal, Copy, Edit and Delete and their dialogs. The
 * Lens view shows one group; search shows one per Lens. Revealed values live
 * only in this component, so they go when it does (another Lens, Lock).
 */
export default function SecretList({ groups, headings, highlight, label, ops, onToast }: SecretListProps) {
  const [revealed, setRevealed] = useState<Record<string, string>>({})
  const [busy, setBusy] = useState<string | null>(null)
  const [copied, setCopied] = useState<string | null>(null)
  // A target stays set while its dialog plays its exit, so the title doesn't
  // go blank; the open flags say whether the dialogs are open.
  const [deleting, setDeleting] = useState<Target | null>(null)
  const [deleteOpen, setDeleteOpen] = useState(false)
  const [editing, setEditing] = useState<Target | null>(null)
  const [editOpen, setEditOpen] = useState(false)
  const copiedTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)
  useEffect(() => () => clearTimeout(copiedTimer.current), [])

  const forget = (key: string) =>
    setRevealed((prev) => {
      const { [key]: _, ...rest } = prev
      return rest
    })

  const toggleReveal = async (lensId: string, item: ItemView) => {
    const key = keyOf(lensId, item.id)
    if (revealed[key] !== undefined) return forget(key)
    setBusy(key)
    try {
      const plaintext = await ops.reveal(lensId, item.id)
      setRevealed((prev) => ({ ...prev, [key]: plaintext }))
    } catch {
      onToast({ message: "Couldn't reveal the secret.", tone: 'error' })
    } finally {
      setBusy(null)
    }
  }

  const copy = async (lensId: string, item: ItemView) => {
    const key = keyOf(lensId, item.id)
    setBusy(key)
    try {
      // Rust puts the value on the clipboard; it never comes back to this page.
      await ops.copy(lensId, item.id)
    } catch {
      onToast({ message: "Couldn't copy the secret.", tone: 'error' })
      return
    } finally {
      setBusy(null)
    }
    clearTimeout(copiedTimer.current)
    setCopied(key)
    copiedTimer.current = setTimeout(() => setCopied(null), COPIED_MS)
    onToast({ message: `${item.label} copied`, detail: 'Clears in 30 s', countdown: 30 })
  }

  const confirmDelete = async () => {
    if (!deleting) return
    setDeleteOpen(false)
    try {
      await ops.remove(deleting.lensId, deleting.item.id)
    } catch {
      onToast({ message: "Couldn't delete the secret. Nothing was changed.", tone: 'error' })
      return
    }
    forget(keyOf(deleting.lensId, deleting.item.id))
    onToast({ message: 'Secret deleted' })
  }

  const rows = (group: Group) =>
    group.items.map((item) => {
      const key = keyOf(group.lens.id, item.id)
      return (
        <SecretRow
          key={key}
          item={item}
          highlight={highlight}
          revealed={revealed[key]}
          copied={copied === key}
          busy={busy === key}
          onReveal={() => toggleReveal(group.lens.id, item)}
          onCopy={() => copy(group.lens.id, item)}
          onEdit={() => {
            setEditing({ lensId: group.lens.id, item })
            setEditOpen(true)
          }}
          onDelete={() => {
            setDeleting({ lensId: group.lens.id, item })
            setDeleteOpen(true)
          }}
        />
      )
    })

  return (
    <>
      {headings ? (
        groups.map((group) => (
          <section key={group.lens.id} aria-label={group.lens.name}>
            <h2 className="mx-3 mt-4 mb-1 flex items-center gap-1.5 text-12 font-medium text-g4">
              <Icon name="lens" />
              {group.lens.name}
            </h2>
            <ul aria-label={`Matches in ${group.lens.name}`}>{rows(group)}</ul>
          </section>
        ))
      ) : (
        <ul aria-label={label}>{groups.flatMap(rows)}</ul>
      )}

      {editing && (
        <SecretDialog
          key={keyOf(editing.lensId, editing.item.id)}
          open={editOpen}
          editing={editing.item}
          onClose={() => setEditOpen(false)}
          onSave={async (edit) => {
            await ops.update(editing.lensId, editing.item.id, edit)
            // A changed value is hidden again until revealed.
            if (edit.value !== undefined) forget(keyOf(editing.lensId, editing.item.id))
            onToast({ message: 'Secret saved' })
          }}
          onFailed={() => onToast({ message: "Couldn't save the secret. Nothing was changed.", tone: 'error' })}
        />
      )}

      <Dialog
        open={deleteOpen}
        onClose={() => setDeleteOpen(false)}
        width={380}
        title={`Delete “${deleting?.item.label ?? ''}”?`}
        description="This can’t be undone. The secret is deleted from its Lens right away."
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
    </>
  )
}
