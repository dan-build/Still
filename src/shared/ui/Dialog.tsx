import { useEffect, useId, useLayoutEffect, useRef, useState, type KeyboardEvent, type ReactNode, type RefObject } from 'react'
import { createPortal } from 'react-dom'

/** How long the exit transition runs before the dialog leaves the page. */
export const DIALOG_EXIT_MS = 150

const FOCUSABLE = 'button:not(:disabled), [href], input:not(:disabled), textarea:not(:disabled), select:not(:disabled), [tabindex]:not([tabindex="-1"])'

interface DialogProps {
  open: boolean
  /** Called on Escape, a click outside, or a Cancel button the caller wires up. */
  onClose: () => void
  /** The dialog's name, shown as its heading. */
  title: string
  /** One or two sentences under the title; it also describes the dialog. */
  description?: ReactNode
  children?: ReactNode
  /** The buttons, right-aligned in the footer. */
  footer: ReactNode
  /** Something at the footer's left, such as a ⌘↵ hint. */
  footerStart?: ReactNode
  /** The element to focus on opening; otherwise the first focusable one. */
  initialFocus?: RefObject<HTMLElement | null>
  /** While false (for example during a save), Escape and outside clicks do nothing. */
  dismissible?: boolean
  width?: number
}

/**
 * The one dialog every form and confirmation uses: a modal that names itself
 * by its title, keeps focus inside, closes on Escape, gives focus back where
 * it was, and makes the rest of the page unreachable while open.
 *
 * It enters from scale .95 over 200ms and leaves faster. The data-mounted
 * attribute is set a frame after mounting so the entry transition runs (the
 * fallback for @starting-style, which needs Safari 17.5).
 */
export function Dialog({
  open,
  onClose,
  title,
  description,
  children,
  footer,
  footerStart,
  initialFocus,
  dismissible = true,
  width = 400,
}: DialogProps) {
  const [present, setPresent] = useState(open)
  const [mounted, setMounted] = useState(false)
  const id = useId()
  const panel = useRef<HTMLDivElement>(null)
  const scrim = useRef<HTMLDivElement>(null)
  const returnFocus = useRef<HTMLElement | null>(null)
  const latest = useRef({ onClose, dismissible })
  latest.current = { onClose, dismissible }

  // Mount, then show on the next frame; hide, then unmount after the exit.
  useEffect(() => {
    if (open) {
      setPresent(true)
      let second = 0
      const first = requestAnimationFrame(() => {
        second = requestAnimationFrame(() => setMounted(true))
      })
      return () => {
        cancelAnimationFrame(first)
        cancelAnimationFrame(second)
      }
    }
    setMounted(false)
    const timer = setTimeout(() => setPresent(false), DIALOG_EXIT_MS)
    return () => clearTimeout(timer)
  }, [open])

  // While open: everything else on the page is inert and hidden from
  // assistive technology, and focus moves in.
  useLayoutEffect(() => {
    if (!open || !present) return
    returnFocus.current = document.activeElement as HTMLElement | null
    const others = [...document.body.children].filter(
      (el): el is HTMLElement => el instanceof HTMLElement && el !== scrim.current && !el.hasAttribute('aria-hidden'),
    )
    for (const el of others) {
      el.setAttribute('aria-hidden', 'true')
      el.setAttribute('inert', '')
    }
    const target = initialFocus?.current ?? panel.current?.querySelector<HTMLElement>(FOCUSABLE) ?? panel.current
    target?.focus()
    return () => {
      for (const el of others) {
        el.removeAttribute('aria-hidden')
        el.removeAttribute('inert')
      }
    }
  }, [open, present, initialFocus])

  // Focus goes back where it was when the dialog closes. This runs after the
  // commit: during one, React puts focus back on whatever had it, which is
  // still the dialog's button while the dialog plays its exit.
  useEffect(() => {
    if (!open || !present) return
    return () => {
      const el = returnFocus.current
      if (el && document.contains(el)) el.focus()
    }
  }, [open, present])

  if (!present) return null

  const onKeyDown = (e: KeyboardEvent) => {
    if (e.key === 'Escape') {
      e.stopPropagation()
      if (latest.current.dismissible) latest.current.onClose()
      return
    }
    if (e.key !== 'Tab' || !panel.current) return
    // Keep Tab inside the dialog.
    const items = [...panel.current.querySelectorAll<HTMLElement>(FOCUSABLE)]
    if (items.length === 0) {
      e.preventDefault()
      return
    }
    const first = items[0]
    const last = items[items.length - 1]
    if (e.shiftKey && document.activeElement === first) {
      e.preventDefault()
      last.focus()
    } else if (!e.shiftKey && document.activeElement === last) {
      e.preventDefault()
      first.focus()
    }
  }

  const shown = open && mounted
  return createPortal(
    <div
      ref={scrim}
      data-ui=""
      data-mounted={shown}
      // While leaving, it's already gone for assistive technology.
      aria-hidden={open ? undefined : true}
      className={[
        'fixed inset-0 z-50 flex items-center justify-center p-4',
        'bg-[rgb(20_24_26/0.18)] dark:bg-[rgb(0_0_0/0.5)]',
        'transition-opacity ease-out-still',
        shown ? 'opacity-100 duration-200' : 'opacity-0 duration-150',
      ].join(' ')}
      onMouseDown={(e) => {
        if (e.target === e.currentTarget && latest.current.dismissible) latest.current.onClose()
      }}
      onKeyDown={onKeyDown}
    >
      <div
        ref={panel}
        role="dialog"
        aria-modal="true"
        aria-labelledby={`${id}-title`}
        aria-describedby={description ? `${id}-description` : undefined}
        tabIndex={-1}
        style={{ width, maxWidth: '100%' }}
        className={[
          'overflow-hidden rounded-12 bg-raised text-g1 outline-none',
          'shadow-[0_0_0_1px_rgb(16_24_28/0.08),0_16px_40px_rgb(16_24_28/0.12),0_2px_6px_rgb(16_24_28/0.06)]',
          'dark:shadow-[0_0_0_1px_rgb(0_0_0/0.6),inset_0_1px_0_rgb(255_255_255/0.06),0_16px_40px_rgb(0_0_0/0.45),0_2px_6px_rgb(0_0_0/0.3)]',
          // Tailwind 4 scales with the scale property, so that's what transitions.
          'transition-[opacity,scale] ease-out-still',
          shown ? 'scale-100 opacity-100 duration-200' : 'scale-[0.95] opacity-0 duration-150 motion-reduce:scale-100',
        ].join(' ')}
      >
        <div className="flex flex-col gap-4 p-5">
          <div className="flex flex-col gap-2.5">
            <h2 id={`${id}-title`} className="text-14 font-semibold">
              {title}
            </h2>
            {description && (
              <p id={`${id}-description`} className="text-13 leading-[1.5] text-g3">
                {description}
              </p>
            )}
          </div>
          {children}
        </div>
        <div className="p-1.5 pt-0">
          <div className="flex items-center justify-end gap-2 rounded-6 bg-sidebar p-2 pl-3 dark:bg-field">
            {footerStart && <div className="mr-auto flex items-center gap-1.5 text-12 text-g4">{footerStart}</div>}
            {footer}
          </div>
        </div>
      </div>
    </div>,
    document.body,
  )
}
