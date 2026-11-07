import { useEffect, useId, useRef, useState, type KeyboardEvent } from 'react'
import { Icon, type IconName } from './Icon'

export interface MenuItem {
  label: string
  icon?: IconName
  /** Shown in red, for actions that remove something. */
  danger?: boolean
  onSelect: () => void
}

interface MenuProps {
  /** The trigger's accessible name, such as "Lens actions". */
  label: string
  items: readonly MenuItem[]
  /** Which edge of the trigger the menu lines up with. */
  align?: 'start' | 'end'
}

/**
 * A ⋯ button that opens a short list of actions. The arrow keys move between
 * them, Return or a click runs one, and Escape, Tab or a click outside closes
 * the menu; focus goes back to the button.
 */
export function Menu({ label, items, align = 'end' }: MenuProps) {
  const [open, setOpen] = useState(false)
  const id = useId()
  const root = useRef<HTMLDivElement>(null)
  const trigger = useRef<HTMLButtonElement>(null)
  const entries = useRef<(HTMLButtonElement | null)[]>([])

  useEffect(() => {
    if (!open) return
    entries.current[0]?.focus()
    const outside = (e: PointerEvent) => {
      if (!root.current?.contains(e.target as Node)) setOpen(false)
    }
    document.addEventListener('pointerdown', outside)
    return () => document.removeEventListener('pointerdown', outside)
  }, [open])

  const close = (refocus = true) => {
    setOpen(false)
    if (refocus) trigger.current?.focus()
  }

  const onKeyDown = (e: KeyboardEvent) => {
    const current = entries.current.indexOf(document.activeElement as HTMLButtonElement)
    const last = items.length - 1
    const next = { ArrowDown: current + 1, ArrowUp: current - 1, Home: 0, End: last }[e.key]
    if (next !== undefined) {
      e.preventDefault()
      entries.current[(next + items.length) % items.length]?.focus()
    } else if (e.key === 'Escape') {
      e.preventDefault()
      e.stopPropagation()
      close()
    } else if (e.key === 'Tab') {
      close(false)
    }
  }

  return (
    <div ref={root} className="relative">
      <button
        ref={trigger}
        type="button"
        aria-label={label}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-controls={open ? id : undefined}
        onClick={() => setOpen((o) => !o)}
        className="focus-ring inline-flex size-7 items-center justify-center rounded-6 text-g5 transition-[background-color,color] duration-150 hover:bg-wash hover:text-g1 aria-expanded:bg-wash aria-expanded:text-g1"
      >
        <Icon name="more" />
      </button>
      {open && (
        <div
          id={id}
          role="menu"
          aria-label={label}
          tabIndex={-1}
          onKeyDown={onKeyDown}
          className={[
            'absolute top-full z-30 mt-1 min-w-[180px] rounded-8 bg-raised p-1',
            'shadow-[var(--shadow-menu)]',
            align === 'end' ? 'right-0' : 'left-0',
          ].join(' ')}
        >
          {items.map((item, i) => (
            <button
              key={item.label}
              ref={(el) => {
                entries.current[i] = el
              }}
              type="button"
              role="menuitem"
              tabIndex={-1}
              onClick={() => {
                close()
                item.onSelect()
              }}
              className={[
                'flex h-7 w-full items-center gap-2 rounded-4 px-2 text-left text-13 font-medium outline-none',
                'transition-[background-color] duration-150 hover:bg-wash focus-visible:bg-wash focus:bg-wash',
                item.danger ? 'text-danger' : 'text-g1',
              ].join(' ')}
            >
              {item.icon && <Icon name={item.icon} className={item.danger ? '' : 'text-g5'} />}
              {item.label}
            </button>
          ))}
        </div>
      )}
    </div>
  )
}
