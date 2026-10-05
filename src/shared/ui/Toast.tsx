import { useEffect, useState } from 'react'
import { Icon } from './Icon'

export interface ToastMessage {
  /** What happened, such as "Router admin copied". */
  message: string
  /** Quieter text after it, such as "Clears in 30 s". */
  detail?: string
  /** Errors are announced at once and marked with the warning icon. */
  tone?: 'info' | 'error'
  /** Seconds for the countdown bar along the bottom (the clipboard clear). */
  countdown?: number
}

/**
 * The live regions for toasts, always on the page so screen readers announce
 * what appears in them: a polite status for info, an alert for errors. Shows
 * one toast at a time at the bottom centre; the caller decides how long.
 */
export function Toaster({ toast }: { toast: (ToastMessage & { id: number }) | null }) {
  const error = toast?.tone === 'error'
  return (
    <div data-ui="" className="pointer-events-none fixed inset-x-0 bottom-5 z-40 flex justify-center">
      <div role="status" aria-live="polite">
        {toast && !error && <Toast key={toast.id} {...toast} />}
      </div>
      <div role="alert">{toast && error && <Toast key={toast.id} {...toast} />}</div>
    </div>
  )
}

function Toast({ message, detail, tone = 'info', countdown }: ToastMessage) {
  // Enter on the next frame, so the transition runs.
  const [shown, setShown] = useState(false)
  useEffect(() => {
    const frame = requestAnimationFrame(() => setShown(true))
    return () => cancelAnimationFrame(frame)
  }, [])

  return (
    <div
      className={[
        'relative flex h-9 items-center gap-2 overflow-hidden whitespace-nowrap rounded-8 bg-raised pr-3.5 pl-3 text-13 font-medium text-g1',
        'shadow-[0_0_0_1px_rgb(16_24_28/0.08),0_16px_40px_rgb(16_24_28/0.12),0_2px_6px_rgb(16_24_28/0.06)]',
        'dark:shadow-[0_0_0_1px_rgb(0_0_0/0.6),inset_0_1px_0_rgb(255_255_255/0.06),0_16px_40px_rgb(0_0_0/0.45),0_2px_6px_rgb(0_0_0/0.3)]',
        'transition-[opacity,translate] duration-200 ease-out-still',
        shown ? 'translate-y-0 opacity-100' : 'translate-y-2 opacity-0 motion-reduce:translate-y-0',
      ].join(' ')}
    >
      <Icon name={tone === 'error' ? 'warning' : 'check'} className={tone === 'error' ? 'text-danger' : 'text-accent'} />
      <span>{message}</span>
      {detail && <span className="font-normal text-g4 tabular-nums">{detail}</span>}
      {countdown && (
        <span
          aria-hidden
          className="absolute bottom-0 left-0 h-0.5 w-full origin-left bg-accent opacity-60"
          style={{ animation: `still-countdown ${countdown}s linear forwards` }}
        />
      )}
    </div>
  )
}
