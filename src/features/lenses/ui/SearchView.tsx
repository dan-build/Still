import type { LensView as Lens } from '@/features/vault/model/types'
import { Button } from '@/shared/ui/Button'
import { Icon } from '@/shared/ui/Icon'
import type { ToastMessage } from '@/shared/ui/Toast'
import { searchVault } from '../model/search'
import SecretList, { type SecretOps } from './SecretList'

interface SearchViewProps {
  lenses: readonly Lens[]
  query: string
  ops: SecretOps
  onClear: () => void
  onToast: (toast: ToastMessage) => void
}

/** Search results: matching secrets from every Lens, grouped by Lens. */
export default function SearchView({ lenses, query, ops, onClear, onToast }: SearchViewProps) {
  const groups = searchVault(lenses, query)
  const total = groups.reduce((n, g) => n + g.items.length, 0)
  const summary =
    total === 0
      ? 'No matches'
      : `${total} ${total === 1 ? 'secret' : 'secrets'} in ${groups.length} ${groups.length === 1 ? 'Lens' : 'Lenses'}`

  return (
    <section aria-labelledby="search-title" className="flex min-h-0 flex-1 flex-col">
      <header data-tauri-drag-region className="flex h-[52px] shrink-0 items-center gap-2 border-b border-hairline pr-4 pl-6">
        <h1 id="search-title" className="pointer-events-none text-14 font-semibold">
          Search
        </h1>
        {/* Announced as the results change. */}
        <span role="status" className="pointer-events-none text-13 text-g4 tabular-nums">
          {summary}
        </span>
        <span className="pointer-events-none flex-1" />
        <Button variant="ghost" icon="close" onClick={onClear}>
          Clear
        </Button>
      </header>

      {total === 0 ? (
        <div className="flex flex-1 flex-col items-center justify-center gap-2 pb-10 text-center">
          <div className="mb-2 flex size-10 items-center justify-center rounded-8 bg-sidebar text-g4 shadow-[inset_0_0_0_1px_var(--hairline)]">
            <Icon name="search" />
          </div>
          <h2 className="max-w-[360px] truncate text-14 font-semibold">Nothing matches “{query.trim()}”</h2>
          <p className="max-w-[300px] text-13 leading-[1.5] text-g3">
            Search looks at labels and Lens names. Values stay encrypted, so they aren’t searched.
          </p>
        </div>
      ) : (
        <div className="min-h-0 flex-1 overflow-y-auto px-3 pb-2">
          <SecretList groups={groups} headings highlight={query.trim()} label="Search results" ops={ops} onToast={onToast} />
        </div>
      )}
    </section>
  )
}
