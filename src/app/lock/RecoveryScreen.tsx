import { useState } from 'react'
import { Button } from '@/shared/ui/Button'
import LockLayout from './LockLayout'

interface RecoveryScreenProps {
  onSetAside: () => Promise<void>
}

// Shown when Still finds saved vault data but not the key that opens it.
// Creating a new vault on top would leave that data unreadable, so the only
// way forward is to set it aside first, after a clear confirmation.
export default function RecoveryScreen({ onSetAside }: RecoveryScreenProps) {
  const [confirming, setConfirming] = useState(false)
  const [isWorking, setIsWorking] = useState(false)
  const [error, setError] = useState('')

  const setAside = async () => {
    setIsWorking(true)
    setError('')
    try {
      await onSetAside()
    } catch {
      setError("Still couldn't set the old data aside. Nothing was changed.")
      setIsWorking(false)
    }
  }

  if (!confirming) {
    return (
      <LockLayout
        warning
        width={400}
        title="Still found data it can't open"
        actions={
          <div className="flex justify-center">
            <Button size="md" onClick={() => setConfirming(true)}>
              Set the old data aside…
            </Button>
          </div>
        }
      >
        <p>
          Your saved Lenses are still on this Mac, but the key that unlocks them is missing, so Still can't open them.
          Creating a new vault now would leave them unreadable for good, so Still won't do that on its own.
        </p>
        <p>If you have a backup of Still's data, restore it and open Still again.</p>
        <p>
          Otherwise, you can set the old data aside and start a new, empty vault. Nothing is deleted: the old data stays on
          this Mac under a different name.
        </p>
      </LockLayout>
    )
  }

  return (
    <LockLayout
      warning
      width={400}
      title="Set the old data aside?"
      footer={
        error ? (
          <span role="alert" className="text-danger">
            {error}
          </span>
        ) : null
      }
      actions={
        <div className="flex justify-center gap-2">
          <Button variant="ghost" size="md" onClick={() => setConfirming(false)} disabled={isWorking}>
            Cancel
          </Button>
          <Button variant="primary" size="md" onClick={setAside} disabled={isWorking}>
            {isWorking ? 'Setting aside…' : 'Set aside and start fresh'}
          </Button>
        </div>
      }
    >
      <p>Still will keep a copy of everything it found, then start a new, empty vault.</p>
      <p>The old Lenses stay unreadable unless the missing key is restored. They won't appear in the new vault.</p>
    </LockLayout>
  )
}
