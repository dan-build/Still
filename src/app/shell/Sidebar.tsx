import type { RefObject } from 'react'
import type { LensView } from '@/platform/storage/backend'
import { IconButton } from '@/shared/ui/Button'
import { Icon, Mark, type IconName } from '@/shared/ui/Icon'
import { Kbd } from '@/shared/ui/Kbd'

export type Selection = { kind: 'lens'; id: string } | { kind: 'archive' }

interface SidebarProps {
  /** The search's text, and where it goes as it changes. */
  query: string
  onQuery: (query: string) => void
  /** The search field, for ⌘F. */
  searchRef: RefObject<HTMLInputElement | null>
  lenses: readonly LensView[]
  selected: Selection | null
  archiveCount: number
  onSelect: (selection: Selection) => void
  onNewLens: () => void
  onLock: () => void
}

const count = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`

/**
 * The sidebar: the mark, the Lenses with their counts, and Archive and Lock
 * at the bottom. The top 52px are the overlay title bar: they hold the
 * window's traffic lights and drag the window.
 */
export default function Sidebar({ lenses, selected, archiveCount, onSelect, onNewLens, onLock, query, onQuery, searchRef }: SidebarProps) {
  return (
    <div
     
      // A faint vertical wash stands in for macOS vibrancy. Plain CSS: Tailwind's
      // gradients interpolate in oklab, which Safari 15 can't parse.
      className="flex w-56 shrink-0 flex-col border-r border-hairline bg-sidebar px-2 pb-2 [background-image:linear-gradient(180deg,#f6f7f7,var(--sidebar)_60%)] dark:[background-image:linear-gradient(180deg,#16181a,var(--sidebar)_60%)]"
    >
      {/* The window's title strip: the traffic lights sit here, and it drags the window. */}
      <div data-tauri-drag-region className="flex h-[52px] shrink-0 items-center justify-end px-2 text-g5">
        <Mark size={16} stroke={1.5} className="pointer-events-none" />
      </div>
      <div role="search" className="mt-1 mb-1.5">
        <label htmlFor="still-search" className="sr-only">
          Search secrets
        </label>
        <div className="flex h-7 items-center gap-2 rounded-6 bg-field pr-1.5 pl-2 text-g4 shadow-[inset_0_0_0_1px_var(--g7)] transition-[box-shadow] duration-150 focus-within:shadow-[inset_0_0_0_1px_var(--accent),0_0_0_3px_var(--accent-soft)]">
          <Icon name="search" />
          <input
            ref={searchRef}
            id="still-search"
            type="search"
            value={query}
            onChange={(e) => onQuery(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Escape') {
                e.preventDefault()
                onQuery('')
              }
            }}
            placeholder="Search"
            spellCheck={false}
            autoComplete="off"
            aria-keyshortcuts="Meta+F"
            className="min-w-0 flex-1 bg-transparent text-13 text-g1 outline-none placeholder:text-g4 [&::-webkit-search-cancel-button]:hidden"
          />
          {query === '' && <Kbd>⌘F</Kbd>}
        </div>
      </div>
      <nav aria-label="Lenses" className="flex min-h-0 flex-1 flex-col">
        <div className="mt-1 flex h-7 items-center justify-between pr-0.5 pl-2">
          <h2 className="text-12 font-medium text-g4">Lenses</h2>
          <IconButton icon="plus" label="New Lens" size="sm" onClick={onNewLens} />
        </div>
        <ul className="mt-0.5 flex min-h-0 flex-col gap-px overflow-y-auto">
          {lenses.map((lens) => (
            <li key={lens.id}>
              <NavItem
                icon="lens"
                current={selected?.kind === 'lens' && selected.id === lens.id}
                count={lens.itemCount}
                countText={count(lens.itemCount, 'secret', 'secrets')}
                onClick={() => onSelect({ kind: 'lens', id: lens.id })}
              >
                {lens.name}
              </NavItem>
            </li>
          ))}
        </ul>
        <div className="flex-1" />
        <div className="-mx-2 flex flex-col gap-px border-t border-hairline px-2 pt-2">
          <NavItem
            icon="archive"
            current={selected?.kind === 'archive'}
            count={archiveCount}
            countText={count(archiveCount, 'Lens', 'Lenses')}
            onClick={() => onSelect({ kind: 'archive' })}
          >
            Archive
          </NavItem>
        </div>
      </nav>
      <button
        type="button"
        onClick={onLock}
        aria-keyshortcuts="Meta+L"
        className={NAV}
      >
        <Icon name="lock" className="text-g5" />
        <span className="min-w-0 flex-1 truncate">Lock</span>
        <Kbd>⌘L</Kbd>
      </button>
    </div>
  )
}

const NAV =
  'focus-ring group flex h-[30px] w-full items-center gap-2 rounded-6 px-2 text-left text-13 font-medium text-g3 ' +
  'transition-[background-color,color] duration-150 hover:bg-wash hover:text-g1'

function NavItem({
  icon,
  current,
  count,
  countText,
  onClick,
  children,
}: {
  icon: IconName
  current: boolean
  count: number
  countText: string
  onClick: () => void
  children: string
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      // The name with its count in words: "Work, 7 secrets".
      aria-label={`${children}, ${countText}`}
      aria-current={current ? 'page' : undefined}
      className={`${NAV} ${current ? 'bg-selected text-g1 hover:bg-selected' : ''}`}
    >
      <Icon name={icon} className={current ? 'text-accent' : 'text-g5'} />
      <span className="min-w-0 flex-1 truncate">{children}</span>
      <span aria-hidden className="text-12 font-medium text-g4 tabular-nums">
        {count}
      </span>
    </button>
  )
}
