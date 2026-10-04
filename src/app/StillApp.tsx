import { useEffect, useState } from 'react'
import { moveOldCopy, openVaultStorage, type Startup } from '@/platform/storage/startup'
import { vaultFile } from '@/platform/tauri/vaultFile'
import StillHome from './App'

/** Opens the vault storage (the file, or a one-time move into it), then shows the app. */
export default function StillApp() {
  const [startup, setStartup] = useState<Startup | null>(null)
  const [busy, setBusy] = useState(false)

  const open = () => openVaultStorage(vaultFile, window.localStorage).then(setStartup)

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
      return <StillHome storage={startup.storage} notice={startup.notice} />
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
          action={{ label: 'Use the older copy', busy, onClick: () => run(() => moveOldCopy(vaultFile, window.localStorage)) }}
        >
          Your vault moved into its own file on {new Date(startup.movedAt).toLocaleDateString()}, and that file has gone. Still kept the copy
          from before the move. It doesn't include anything changed since then. Restore the file from a backup if you have one, or use the
          older copy.
        </Message>
      )
    case 'failed':
      return (
        <Message title="Still couldn't open its vault file" action={{ label: 'Try again', busy, onClick: () => run(() => openVaultStorage(vaultFile, window.localStorage)) }}>
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
  return (
    <div className="min-h-screen flex items-center justify-center bg-still-bg">
      <div className="w-full max-w-[440px] px-6 text-center">
        <h1 className="text-2xl font-semibold tracking-tight text-[#151515] mb-4">{title}</h1>
        {children && <p className="text-[15px] text-still-muted leading-relaxed">{children}</p>}
        {action && (
          <button
            onClick={action.onClick}
            disabled={action.busy}
            className="mt-8 w-full py-3.5 rounded-2xl bg-[#151515] text-white text-[15px] disabled:opacity-50"
          >
            {action.busy ? 'Working…' : action.label}
          </button>
        )}
      </div>
    </div>
  )
}
