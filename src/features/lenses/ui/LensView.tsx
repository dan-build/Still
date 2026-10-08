import { useState } from 'react'
import type { LensView as Lens, NewItem } from '@/features/vault/model/types'
import { Button } from '@/shared/ui/Button'
import { Dialog } from '@/shared/ui/Dialog'
import { Icon } from '@/shared/ui/Icon'
import { Menu } from '@/shared/ui/Menu'
import type { ToastMessage } from '@/shared/ui/Toast'
import LensNameDialog from './LensNameDialog'
import SecretDialog from './SecretDialog'
import SecretList, { type SecretOps } from './SecretList'

interface LensViewProps {
  lens: Lens
  onAddItem: (item: NewItem) => Promise<void>
  /** Reveal, copy, edit and delete, by Lens and secret. */
  ops: SecretOps
  onToast: (toast: ToastMessage) => void
  onForget: () => void
  /** Renames the Lens; resolves false if it couldn't be saved. */
  onRename: (name: string) => Promise<boolean>
}

/** The selected Lens: its secrets as rows, with Add secret and the Lens's actions. */
// App keys this view by Lens, so another Lens starts fresh: nothing revealed
// carries over.
export default function LensView({ lens, onAddItem, ops, onToast, onForget, onRename }: LensViewProps) {
  const [adding, setAdding] = useState(false)
  const [forgetting, setForgetting] = useState(false)
  const [renaming, setRenaming] = useState(false)

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
        <Menu
          label="Lens actions"
          items={[
            { label: 'Rename Lens', icon: 'edit', onSelect: () => setRenaming(true) },
            { label: 'Forget Lens', icon: 'trash', danger: true, onSelect: () => setForgetting(true) },
          ]}
        />
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
          <SecretList groups={[{ lens, items: lens.items }]} label={`Secrets in ${lens.name}`} ops={ops} onToast={onToast} />
        </div>
      )}

      <SecretDialog
        open={adding}
        onClose={() => setAdding(false)}
        onSave={async ({ label, type, value }) => {
          await onAddItem({ label, type, value: value ?? '' })
          onToast({ message: 'Secret added' })
        }}
        onFailed={() => onToast({ message: "Couldn't save the secret. Nothing was changed.", tone: 'error' })}
      />

      <LensNameDialog
        open={renaming}
        renaming={lens.name}
        onClose={() => setRenaming(false)}
        onSubmit={async (name) => {
          const saved = await onRename(name)
          if (saved) setRenaming(false)
          return saved
        }}
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
    </section>
  )
}
