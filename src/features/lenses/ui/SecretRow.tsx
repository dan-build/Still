import type { ItemView } from '@/features/vault/model/types'
import { IconButton } from '@/shared/ui/Button'
import { Icon } from '@/shared/ui/Icon'

const TYPE_NAMES = { password: 'Password', key: 'API key', note: 'Note' } as const

interface SecretRowProps {
  item: ItemView
  /** Text to mark in the label (the search). */
  highlight?: string
  /** The plaintext, while revealed. */
  revealed: string | undefined
  /** The value was just copied: the copy icon shows a check. */
  copied: boolean
  busy: boolean
  onReveal: () => void
  onCopy: () => void
  onEdit: () => void
  onDelete: () => void
}

/**
 * One secret: its type, label and value, with Reveal, Copy, Edit and Delete. The
 * actions show on hover or keyboard focus, and stay while the value is
 * revealed. A hidden value is always ten dots, so its length never shows.
 */
/** The label with the first match of the search marked. */
function Label({ text, highlight }: { text: string; highlight?: string }) {
  const at = highlight ? text.toLocaleLowerCase().indexOf(highlight.toLocaleLowerCase()) : -1
  if (!highlight || at < 0) return <>{text}</>
  return (
    <>
      {text.slice(0, at)}
      <mark className="rounded-[3px] bg-accent-soft text-inherit">{text.slice(at, at + highlight.length)}</mark>
      {text.slice(at + highlight.length)}
    </>
  )
}

export default function SecretRow({ item, highlight, revealed, copied, busy, onReveal, onCopy, onEdit, onDelete }: SecretRowProps) {
  const isRevealed = revealed !== undefined
  const tall = isRevealed && item.type === 'note'
  return (
    <li
      className={[
        'group relative flex min-h-[42px] gap-3 rounded-6 pr-1.5 pl-3 transition-[background-color] duration-150 hover:bg-hover focus-within:bg-hover',
        // A hairline between rows, starting after the icon.
        'before:absolute before:top-0 before:right-3 before:left-10 before:h-px before:bg-hairline first:before:hidden hover:before:hidden',
        tall ? 'items-start' : 'items-center',
      ].join(' ')}
    >
      <span className={`flex text-g5 ${tall ? 'mt-[13px]' : ''}`}>
        <Icon name={item.type === 'key' ? 'key' : item.type} label={TYPE_NAMES[item.type]} />
      </span>
      <span className={`w-[220px] shrink-0 truncate text-13 font-medium ${tall ? 'mt-3 leading-[1.5]' : ''}`}>
        <Label text={item.label} highlight={highlight} />
      </span>
      <span
        data-testid="secret-value"
        className={[
          'min-w-0 flex-1 text-13 whitespace-pre-wrap break-all',
          !isRevealed ? 'font-mono tracking-[0.5px] text-g4' : item.type === 'note' ? 'py-3 leading-[1.5] text-g2 select-text' : 'font-mono text-g2 select-text',
        ].join(' ')}
      >
        {isRevealed ? (
          revealed
        ) : (
          <>
            <span aria-hidden>••••••••••</span>
            <span className="sr-only">Hidden</span>
          </>
        )}
      </span>
      <span
        className={[
          'flex gap-0.5 transition-opacity duration-150',
          isRevealed || copied ? 'opacity-100' : 'opacity-0 group-hover:opacity-100 group-focus-within:opacity-100',
          tall ? 'mt-2' : '',
        ].join(' ')}
      >
        <IconButton
          icon={isRevealed ? 'eye-off' : 'eye'}
          label={`Reveal ${item.label}`}
          aria-pressed={isRevealed}
          disabled={busy}
          onClick={onReveal}
        />
        <button
          type="button"
          aria-label={copied ? `Copied ${item.label}` : `Copy ${item.label}`}
          disabled={busy}
          onClick={onCopy}
          className="focus-ring relative inline-flex size-7 items-center justify-center rounded-6 text-g5 transition-[background-color,color] duration-150 hover:bg-wash hover:text-g1 disabled:opacity-45"
        >
          {/* The copy icon swaps to a check: cross-fade, scale and blur. */}
          <span className="relative size-4">
            <span className={`swap-icon absolute inset-0 ${copied ? 'swap-out' : ''}`}>
              <Icon name="copy" />
            </span>
            <span className={`swap-icon absolute inset-0 text-accent ${copied ? '' : 'swap-out'}`}>
              <Icon name="check" />
            </span>
          </span>
        </button>
        <IconButton icon="edit" label={`Edit ${item.label}`} onClick={onEdit} />
        <IconButton icon="trash" label={`Delete ${item.label}`} danger onClick={onDelete} />
      </span>
    </li>
  )
}
