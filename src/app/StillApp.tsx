import { useEffect, useState } from 'react'
import { openVault, restoreOldCopy, type Startup } from '@/platform/tauri/startup'
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
      return <StillHome notice={startup.notice} />
    case 'already-open':
      return (
        <Message title="Still is already open">
          Use the Still window that's already open. Only one can use your vault at a time, so this one has stopped. You can quit it.
        </Message>
      )
    case 'unreadable':
      return (
        <Message title="Still can't read its vault file">
          Nothing was changed. The file and its previous version (vault.json.bak) are in Still's app data folder. Keep both safe, and
          don't create a new vault until they're dealt with.
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
}: {
  title: string
  children?: React.ReactNode
  action?: { label: string; busy: boolean; onClick: () => void }
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
          <div className="flex justify-center">
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
