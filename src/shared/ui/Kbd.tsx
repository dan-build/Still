/**
 * A keyboard shortcut hint, such as ⌘L. Decorative: the control it belongs to
 * states the shortcut with aria-keyshortcuts.
 */
export function Kbd({ children }: { children: string }) {
  return (
    <kbd
      aria-hidden
      className="inline-flex h-[18px] min-w-[18px] items-center justify-center rounded-4 px-1 font-sans text-12 font-medium text-g4 tabular-nums shadow-[inset_0_0_0_1px_var(--g7)]"
    >
      {children}
    </kbd>
  )
}
