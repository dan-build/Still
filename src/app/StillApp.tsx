import { useEffect, useState } from 'react'
import { openOldFormat, openVault, restoreKeptCopy, restoreOldCopy, type Startup } from '@/platform/tauri/startup'
import { Button } from '@/shared/ui/Button'
import StillHome from './App'
import LockLayout from './lock/LockLayout'

/** Opens the vault file (or moves an older version's vault into it, once), then shows the app. */
export default function StillApp() {
  const [startup, setStartup] = useState<Startup | null>(null)
  const [busy, setBusy] = useState(false)

  const open = () => openVault(window.localStorage).then(setStartup)

  useEffect(() => {
    open()
  }, [])

  const run = async (step: () => Promise<Startup>) => {
    setBusy(true)
    try {
      setStartup(await step())
    } finally {
      setBusy(false)
    }
  }

  if (startup === null) return <Message title="Opening Still…" />

  switch (startup.kind) {
    case 'ready':
      return <StillHome notice={startup.notice} onDamaged={() => setStartup({ kind: 'unreadable', canRestore: true })} />
    case 'already-open':
      return (
        <Message title="Still is already open">
          Use the Still window that's already open. Only one can use your vault at a time, so this one has stopped. You can quit it.
        </Message>
      )
    case 'unreadable':
      return startup.canRestore ? (
        <Message
          title="Still can't open its vault file"
          action={{ label: 'Use the kept copy', busy, onClick: () => run(() => restoreKeptCopy(window.localStorage)) }}
        >
          Nothing was changed. The file is missing, damaged, or from a newer version of Still. Still kept an earlier copy: the file as it
          was before your last change, or the file from before the upgrade to the new format. Either may lack your most recent changes.
          Restore vault.json from a backup if you have one, or use the kept copy. Nothing is deleted either way.
        </Message>
      ) : (
        <Message title="Still can't read its vault file">
          Nothing was changed. It may be damaged, or from a newer version of Still. The file and its previous version (vault.json.bak) are
          in Still's app data folder. Keep both safe, and don't create a new vault until they're dealt with.
        </Message>
      )
    case 'old-format':
      return (
        <Message
          title="This vault is in the old format"
          action={{ label: 'Open anyway', busy, onClick: () => run(() => openOldFormat(window.localStorage, false)) }}
          secondary={{ label: 'Open and upgrade it', onClick: () => run(() => openOldFormat(window.localStorage, true)) }}
        >
          Your vault was upgraded to the new format on {new Date(startup.convertedAt).toLocaleDateString()}, but the file there now is in the
          old format: an older copy, or one that was changed. Open it only if you put it back on purpose. Open anyway keeps it as it is;
          upgrading makes it your vault from now on.
        </Message>
      )
    case 'file-missing':
      return (
        <Message
          title="Your vault file is missing"
          action={{ label: 'Use the older copy', busy, onClick: () => run(() => restoreOldCopy(window.localStorage)) }}
        >
          Your vault moved into its own file on {new Date(startup.movedAt).toLocaleDateString()}, and that file has gone. Still kept the copy
          from before the move. It doesn't include anything changed since then. Restore the file from a backup if you have one, or use the
          older copy.
        </Message>
      )
    case 'failed':
      return (
        <Message title="Still couldn't open its vault file" action={{ label: 'Try again', busy, onClick: () => run(() => openVault(window.localStorage)) }}>
          Nothing was changed.
        </Message>
      )
  }
}

function Message({
  title,
  children,
  action,
  secondary,
}: {
  title: string
  children?: React.ReactNode
  action?: { label: string; busy: boolean; onClick: () => void }
  /** A second, quieter choice next to the action. */
  secondary?: { label: string; onClick: () => void }
}) {
  // "Opening Still…" shows the mark; every other message is a problem.
  const problem = Boolean(children)
  return (
    <LockLayout
      title={title}
      warning={problem}
      width={400}
      actions={
        action && (
          <div className="flex justify-center gap-2">
            {secondary && (
              <Button size="md" variant="ghost" onClick={secondary.onClick} disabled={action.busy}>
                {secondary.label}
              </Button>
            )}
            <Button size="md" onClick={action.onClick} disabled={action.busy}>
              {action.busy ? 'Working…' : action.label}
            </Button>
          </div>
        )
      }
    >
      {children && <p>{children}</p>}
    </LockLayout>
  )
}
