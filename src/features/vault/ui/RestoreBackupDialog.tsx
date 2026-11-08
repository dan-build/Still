import { useRef, useState, type FormEvent } from 'react'
import type { BackupSummary } from '@/features/vault/model/types'
import { VaultApiError } from '@/platform/tauri/vaultApi'
import { Button } from '@/shared/ui/Button'
import { Dialog } from '@/shared/ui/Dialog'
import { TextField } from '@/shared/ui/TextField'

interface RestoreBackupDialogProps {
  /** The backup chosen in the open dialog. */
  chosen: { name: string; modifiedAt?: number | null } | null
  onClose: () => void
  /** Opens the backup with its own password and says what it holds. */
  onCheck: (password: string) => Promise<BackupSummary>
  /** Replaces the vault with it; resolves with the name the replaced vault was kept as. */
  onConfirm: () => Promise<string | null>
  onRestored: (kept: string | null) => void
}

const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`

function when(modifiedAt: number | null | undefined): string {
  if (!modifiedAt) return ''
  const days = Math.floor((Date.now() - modifiedAt) / 86_400_000)
  const date = new Date(modifiedAt).toLocaleDateString()
  return days < 1 ? `saved ${date}, today` : `saved ${date}, ${plural(days, 'day', 'days')} ago`
}

/**
 * Restore a backup: its own password first (which proves it opens), then
 * what it holds and a plain warning, then the replacement.
 */
export default function RestoreBackupDialog({ chosen, onClose, onCheck, onConfirm, onRestored }: RestoreBackupDialogProps) {
  const [password, setPassword] = useState('')
  const [summary, setSummary] = useState<BackupSummary | null>(null)
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)
  const field = useRef<HTMLInputElement>(null)

  const close = () => {
    if (busy) return
    setPassword('')
    setSummary(null)
    setError('')
    onClose()
  }

  const check = async (e: FormEvent) => {
    e.preventDefault()
    if (!password || busy) return
    setBusy(true)
    setError('')
    try {
      setSummary(await onCheck(password))
    } catch (err) {
      const code = err instanceof VaultApiError ? err.code : 'failed'
      setError(
        code === 'wrong-password'
          ? 'Incorrect password for this backup.'
          : code === 'damaged'
            ? "This backup is damaged and can't be restored."
            : "Couldn't open the backup. Nothing was changed.",
      )
    } finally {
      setBusy(false)
    }
  }

  const confirm = async () => {
    setBusy(true)
    setError('')
    try {
      const kept = await onConfirm()
      setBusy(false)
      setPassword('')
      setSummary(null)
      onRestored(kept)
    } catch {
      setBusy(false)
      setError("Couldn't restore the backup. Your vault is unchanged.")
    }
  }

  return (
    <Dialog
      open={chosen !== null}
      onClose={close}
      dismissible={!busy}
      width={420}
      title="Restore from a backup"
      description={chosen ? `${chosen.name}${chosen.modifiedAt ? `, ${when(chosen.modifiedAt)}` : ''}` : undefined}
      initialFocus={field}
      footerStart={busy && !summary ? <span className="text-12 text-g4">This takes a few seconds.</span> : undefined}
      footer={
        <>
          <Button variant="ghost" onClick={close} disabled={busy}>
            Cancel
          </Button>
          {summary ? (
            <Button variant="danger" onClick={confirm} disabled={busy}>
              {busy ? 'Restoring…' : 'Replace my vault'}
            </Button>
          ) : (
            <Button variant="primary" type="submit" form="restore-backup" disabled={!password || busy}>
              {busy ? 'Checking…' : 'Check backup'}
            </Button>
          )}
        </>
      }
    >
      {summary ? (
        <div className="flex flex-col gap-2 text-13 leading-[1.5] text-g3">
          <p className="font-medium text-g1">
            This backup holds {plural(summary.lenses, 'Lens', 'Lenses')} with {plural(summary.secrets, 'secret', 'secrets')}
            {summary.archived > 0 ? `, and ${summary.archived} in the Archive` : ''}.
          </p>
          <p>
            It will replace your vault. Anything changed since the backup was saved won't be in it. Your current vault is kept as a copy in
            Still's app data folder, so nothing is lost.
          </p>
          <p>After restoring, Still locks: unlock with the backup's password.</p>
          {error && (
            <p role="alert" className="text-12 text-danger">
              {error}
            </p>
          )}
        </div>
      ) : (
        <form id="restore-backup" onSubmit={check}>
          <TextField
            ref={field}
            label="The backup's password"
            type="password"
            autoComplete="off"
            spellCheck={false}
            hint="The master password the vault had when this backup was saved."
            error={error || undefined}
            value={password}
            disabled={busy}
            onChange={(e) => setPassword(e.target.value)}
          />
        </form>
      )}
    </Dialog>
  )
}
