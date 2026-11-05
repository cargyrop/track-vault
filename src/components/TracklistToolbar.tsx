import { useEffect, useRef, useState } from 'react'
import type { Facets } from '../hooks/useLibrary'
import type { LibraryFilter } from '../lib/types'
import { filterCount, filterTokens } from '../lib/filterTokens'
import {
  SORT_KEYS,
  SORT_LABELS,
  type SortKey,
  type SortState,
} from '../lib/trackSort'
import { FilterIcon, SortIcon } from './icons'

interface Props {
  facets: Facets
  filter: LibraryFilter
  onChange: (patch: Partial<LibraryFilter>) => void
  onToggleGenre: (genre: string) => void
  onClear: () => void
  sort: SortState
  onSortChange: (sort: SortState) => void
  /** How many rows survived the filters, said out loud when it is fewer. */
  shown: number
}

/**
 * Narrowing and ordering the list, in the same band as the rows it changes.
 *
 * The filter panel used to be a permanent column of every genre in the library:
 * it grew with the collection and it took room from the list it was filtering.
 * What is left is the part that earns its space every day — one search box —
 * plus two doors: a popover for the filters you reach for occasionally, and a
 * sort menu, which the app did not have at all. Whatever *is* on is named in a
 * single line of removable chips underneath, because a filter you cannot see is
 * a filter you cannot explain to yourself when the list comes back short.
 */
export function TracklistToolbar({
  facets,
  filter,
  onChange,
  onToggleGenre,
  onClear,
  sort,
  onSortChange,
  shown,
}: Props) {
  const [filtersOpen, setFiltersOpen] = useState(false)
  const popover = useRef<HTMLDivElement | null>(null)
  const trigger = useRef<HTMLButtonElement | null>(null)
  const tokens = filterTokens(filter)
  const count = filterCount(filter)

  // A popover with no scrim has to close the way a native one does: Escape, or
  // a press anywhere else. Both are also what a phone user will try first.
  useEffect(() => {
    if (!filtersOpen) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        setFiltersOpen(false)
        trigger.current?.focus()
      }
    }
    const onDown = (e: PointerEvent) => {
      const target = e.target as Node
      if (popover.current?.contains(target)) return
      if (trigger.current?.contains(target)) return
      setFiltersOpen(false)
    }
    window.addEventListener('keydown', onKey)
    window.addEventListener('pointerdown', onDown)
    return () => {
      window.removeEventListener('keydown', onKey)
      window.removeEventListener('pointerdown', onDown)
    }
  }, [filtersOpen])

  const toggleSortDirection = () => {
    onSortChange({ ...sort, dir: sort.dir === 'asc' ? 'desc' : 'asc' })
  }

  return (
    <div className="toolbar">
      <div className="toolbar-row">
        <input
          type="search"
          className="toolbar-search"
          placeholder="Search this list"
          value={filter.search}
          onChange={(e) => onChange({ search: e.target.value })}
          aria-label="Search this list by title, artist or album"
        />

        <div className="toolbar-popover-host">
          <button
            ref={trigger}
            type="button"
            className={count ? 'toolbar-btn on' : 'toolbar-btn'}
            aria-expanded={filtersOpen}
            aria-haspopup="dialog"
            onClick={() => setFiltersOpen((open) => !open)}
            title="Filters — genre, flags and link type"
          >
            <FilterIcon />
            <span className="toolbar-btn-label">Filters</span>
            {count > 0 && <span className="badge">{count}</span>}
          </button>

          {filtersOpen && (
            <div
              ref={popover}
              className="filters-popover"
              role="dialog"
              aria-label="Filters"
            >
              <div className="filters-popover-head">
                <strong>Filters</strong>
                <button
                  type="button"
                  className="ghost-btn"
                  onClick={onClear}
                  disabled={!count}
                >
                  Clear
                </button>
              </div>

              <p className="filters-group-label">Flags</p>
              <div className="chip-row">
                <button
                  type="button"
                  className={`chip toggle ${filter.unfiledOnly ? 'on' : ''}`}
                  aria-pressed={filter.unfiledOnly}
                  onClick={() => onChange({ unfiledOnly: !filter.unfiledOnly })}
                  title="Only tracks in no playlist"
                >
                  Not in a playlist
                </button>
                <button
                  type="button"
                  className={`chip toggle ${filter.hasLiveSource ? 'on' : ''}`}
                  aria-pressed={filter.hasLiveSource}
                  onClick={() => onChange({ hasLiveSource: !filter.hasLiveSource })}
                  title="Only tracks with a live take attached"
                >
                  Has a live take
                </button>
              </div>

              {facets.genres.length > 0 && (
                <>
                  <p className="filters-group-label">
                    Genres <span className="hint-inline">— any of these</span>
                  </p>
                  <div className="chip-row scroll">
                    {facets.genres.map((genre) => {
                      const on = filter.genres.includes(genre.name)
                      return (
                        <button
                          key={genre.name}
                          type="button"
                          className={`chip toggle ${on ? 'on' : ''}`}
                          aria-pressed={on}
                          onClick={() => onToggleGenre(genre.name)}
                        >
                          {genre.name}
                          <span className="chip-count">{genre.count}</span>
                        </button>
                      )
                    })}
                  </div>
                </>
              )}
            </div>
          )}
        </div>

        <div className="toolbar-sort">
          <SortIcon />
          <select
            className="sort-select"
            aria-label="Sort this list"
            value={sort.key}
            onChange={(e) =>
              onSortChange({ ...sort, key: e.target.value as SortKey })
            }
          >
            {SORT_KEYS.map((key) => (
              <option key={key} value={key}>
                {SORT_LABELS[key]}
              </option>
            ))}
          </select>
          <button
            type="button"
            className="sort-dir"
            onClick={toggleSortDirection}
            disabled={sort.key === 'manual'}
            aria-label={sort.dir === 'asc' ? 'Sort ascending' : 'Sort descending'}
            title={sort.dir === 'asc' ? 'Ascending — click for descending' : 'Descending — click for ascending'}
          >
            {sort.dir === 'asc' ? '↑' : '↓'}
          </button>
        </div>
      </div>

      {tokens.length > 0 && (
        <div className="toolbar-tokens">
          {tokens.map((token) => (
            <button
              key={token.key}
              type="button"
              className="token"
              onClick={() => onChange(token.clear)}
              title={`Remove the ${token.label} filter`}
            >
              <span>{token.label}</span>
              <span aria-hidden="true">×</span>
            </button>
          ))}
          <button type="button" className="token clear" onClick={onClear}>
            Clear all
          </button>
        </div>
      )}

      {tokens.length > 0 && shown === 0 && (
        <p className="toolbar-empty hint" role="status">
          No tracks match these filters.
        </p>
      )}
    </div>
  )
}
