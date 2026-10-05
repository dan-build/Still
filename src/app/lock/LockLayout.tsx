import type { ReactNode } from 'react'
import { Icon, Mark } from '@/shared/ui/Icon'

interface LockLayoutProps {
  title: string
  /** A sentence or two under the title. */
  children?: ReactNode
  /** The form or buttons below the text. */
  actions?: ReactNode
  /** A quiet line under the actions (status, errors, reassurance). */
  footer?: ReactNode
  /** Breathe the glow behind the mark (while unlocking). */
  breathing?: boolean
  /** Show the warning icon instead of the mark (start-up problems). */
  warning?: boolean
  width?: number
}

/**
 * The full-window screens before the vault is open: the mark with its glow,
 * a title, a short text and one action. Unlock is the signature: the mark,
 * one field, nothing else.
 */
export default function LockLayout({ title, children, actions, footer, breathing, warning, width = 300 }: LockLayoutProps) {
  return (
    <main className="relative flex min-h-screen w-full items-center justify-center bg-bg px-6 text-g1">
      {/* The title strip, under the traffic lights: it drags the window. */}
      <div data-tauri-drag-region className="absolute inset-x-0 top-0 h-[52px]" />
      <div className="-mt-6 flex flex-col items-center text-center" style={{ width, maxWidth: '100%' }}>
        <div className="relative mb-6 flex size-12 items-center justify-center">
          {warning ? (
            // The 16px icon at 24px, as on the approved mockup.
            <span className="relative z-10 scale-150 text-warning">
              <Icon name="warning" />
            </span>
          ) : (
            <>
              <div
                aria-hidden
                data-breathing={breathing ? 'true' : 'false'}
                className="still-glow pointer-events-none absolute top-1/2 left-1/2 -mt-[110px] -ml-[110px] size-[220px] rounded-full"
              />
              <Mark size={48} stroke={2} className="relative z-10" />
            </>
          )}
        </div>
        <h1 className="text-16 font-semibold tracking-[-0.01em]">{title}</h1>
        {children && <div className="mt-3 flex flex-col gap-2 text-13 leading-[1.5] text-g3">{children}</div>}
        {actions && <div className="mt-6 w-full text-left">{actions}</div>}
        {footer && <div className="mt-5 flex min-h-[18px] items-center justify-center gap-1.5 text-12 leading-[1.5] text-g4">{footer}</div>}
      </div>
    </main>
  )
}
