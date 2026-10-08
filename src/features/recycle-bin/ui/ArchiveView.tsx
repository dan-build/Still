import { useState } from 'react'
import { RECYCLE_DAYS, type LensView as Lens } from '@/features/vault/model/types'
import { Button, IconButton } from '@/shared/ui/Button'
import { Dialog } from '@/shared/ui/Dialog'
import { Icon } from '@/shared/ui/Icon'

const DAY_MS = 24 * 60 * 60 * 1000

/**
 * Whole days until a forgotten Lens is purged, at least 1: purging happens
 * when the vault is unlocked, so an entry that runs out while it's open stays
 * until then.
 */
export function daysLeft(deletedAt: string | undefined, now: Date): number {
  const deleted = deletedAt ? Date.parse(deletedAt) : NaN
  if (Number.isNaN(deleted)) return RECYCLE_DAYS
  return Math.max(1, Math.ceil((deleted + RECYCLE_DAYS * DAY_MS - now.getTime()) / DAY_MS))
}

interface ArchiveViewProps {
  bin: readonly Lens[]
  onRestore: (lens: Lens) => void
  onDeleteForever: (lens: Lens) => void
  now?: Date
}

/** Forgotten Lenses, kept for 7 days: restore one, or delete it now. */
export default function ArchiveView({ bin, onRestore, onDeleteForever, now = new Date() }: ArchiveViewProps) {
  const [deleting, setDeleting] = useState<Lens | null>(null)
  const [deleteOpen, setDeleteOpen] = useState(false)

  return (
    <section aria-labelledby="archive-title" className="flex min-h-0 flex-1 flex-col">
      {/* Part of the title strip: it drags the window; the text lets presses through. */}
      <header data-tauri-drag-region className="flex h-[52px] shrink-0 items-center gap-2 border-b border-hairline pr-4 pl-6">
        <h1 id="archive-title" className="pointer-events-none text-14 font-semibold">
          Archive
        </h1>
        <span className="pointer-events-none text-13 text-g4 tabular-nums">{bin.length === 1 ? '1 Lens' : `${bin.length} Lenses`}</span>
      </header>

      {bin.length === 0 ? (
        <div className="flex flex-1 flex-col items-center justify-center gap-2 pb-10 text-center">
          <div className="mb-2 flex size-10 items-center justify-center rounded-8 bg-sidebar text-g4 shadow-[inset_0_0_0_1px_var(--hairline)]">
            <Icon name="archive" />
          </div>
          <h2 className="text-14 font-semibold">Archive is empty</h2>
          <p className="max-w-[300px] text-13 leading-[1.5] text-g3">Lenses you forget stay here for 7 days, so you can restore them.</p>
        </div>
      ) : (
        <div className="min-h-0 flex-1 overflow-y-auto">
          <p className="mx-6 mt-4 mb-2 text-13 leading-[1.5] text-g3">
            Forgotten Lenses stay here for 7 days, then they’re deleted for good. Restore one any time before then.
          </p>
          <ul aria-label="Forgotten Lenses" className="px-3 pb-2">
            {bin.map((lens) => {
              const days = daysLeft(lens.deletedAt, now)
              return (
                <li
                  key={lens.id}
                  className="relative flex min-h-[42px] items-center gap-3 rounded-6 pr-1.5 pl-3 transition-[background-color] duration-150 before:absolute before:top-0 before:right-3 before:left-10 before:h-px before:bg-hairline first:before:hidden hover:bg-hover hover:before:hidden"
                >
                  <Icon name="lens" className="text-g5" />
                  <span className="w-[200px] shrink-0 truncate text-13 font-medium">{lens.name}</span>
                  <span className="flex-1 text-12 text-g4 tabular-nums">
                    {lens.itemCount === 1 ? '1 secret' : `${lens.itemCount} secrets`}
                  </span>
                  {/* The last day turns amber. */}
                  <span className={`w-[90px] text-12 tabular-nums ${days <= 1 ? 'text-warning' : 'text-g4'}`}>
                    {days === 1 ? '1 day left' : `${days} days left`}
                  </span>
                  <span className="flex items-center gap-1.5">
                    <Button icon="restore" aria-label={`Restore ${lens.name}`} onClick={() => onRestore(lens)}>
                      Restore
                    </Button>
                    <IconButton
                      icon="trash"
                      danger
                      label={`Delete ${lens.name} now`}
                      onClick={() => {
                        setDeleting(lens)
                        setDeleteOpen(true)
                      }}
                    />
                  </span>
                </li>
              )
            })}
          </ul>
        </div>
      )}

      <Dialog
        open={deleteOpen}
        onClose={() => setDeleteOpen(false)}
        width={380}
        title={`Delete “${deleting?.name ?? ''}” now?`}
        description={`Its ${deleting?.itemCount === 1 ? 'secret is' : 'secrets are'} deleted for good. This can’t be undone.`}
        footer={
          <>
            <Button variant="ghost" onClick={() => setDeleteOpen(false)}>
              Cancel
            </Button>
            <Button
              variant="danger"
              onClick={() => {
                setDeleteOpen(false)
                if (deleting) onDeleteForever(deleting)
              }}
            >
              Delete forever
            </Button>
          </>
        }
      />
    </section>
  )
}
