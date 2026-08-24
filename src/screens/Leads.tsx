import { useDeferredValue, useMemo, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { TopBar } from '../components/nav/TopBar'
import { Chip } from '../components/ui/Chip'
import { PropertyRow } from '../components/property/PropertyRow'
import { PropertyPeek } from '../components/property/PropertyPeek'
import { VirtualList } from '../components/ui/VirtualList'
import { useAppStore, useScopedProperties } from '../store/useAppStore'
import { useIsDesktop } from '../lib/useMediaQuery'
import { distanceMiles } from '../lib/geo'
import { IconSearch } from '../components/nav/icons'
import type { LeadStatus, Property } from '../types'
import { STATUS_LABEL } from '../data/outcomes'

type Sort = 'nearest' | 'score' | 'recent' | 'value'

const SORTS: { key: Sort; label: string }[] = [
  { key: 'nearest', label: 'Nearest' },
  { key: 'score', label: 'Best score' },
  { key: 'value', label: 'Value' },
  { key: 'recent', label: 'Recent' },
]

const STATUS_FILTERS: (LeadStatus | 'all')[] = [
  'all',
  'new',
  'contacted',
  'working',
  'appointment',
  'quoted',
  'won',
]

const ROW_HEIGHT = 108

/**
 * Lead list.
 *
 * Defaults to "nearest" because the question a rep is asking is almost always
 * "what's close to me right now", not "show me everything". Search and sort are
 * one tap away; the list itself is windowed so scrolling stays smooth on cheap
 * hardware with a full territory loaded.
 */
export function Leads() {
  const nav = useNavigate()
  const properties = useAppStore((s) => s.properties)
  const scoped = useScopedProperties()
  const position = useAppStore((s) => s.position)
  const [query, setQuery] = useState('')
  const [status, setStatus] = useState<LeadStatus | 'all'>('all')
  const [sort, setSort] = useState<Sort>('nearest')
  const [previewId, setPreviewId] = useState<string | null>(null)
  // The preview pane needs a list *and* a readable detail column beside it —
  // that only fits from `lg`. Below it, rows push a full detail screen.
  const isDesktop = useIsDesktop()
  const preview = previewId ? properties[previewId] : undefined

  // Keeps typing responsive — the list re-filters at a lower priority.
  const deferredQuery = useDeferredValue(query)

  const list = useMemo(() => {
    const q = deferredQuery.trim().toLowerCase()
    let rows: Property[] = [...scoped]

    if (status !== 'all') rows = rows.filter((p) => p.status === status)
    if (q) {
      rows = rows.filter(
        (p) =>
          p.address1.toLowerCase().includes(q) ||
          p.contacts.some((c) => c.name.toLowerCase().includes(q)),
      )
    }

    switch (sort) {
      case 'nearest':
        if (position) {
          return rows
            .map((p) => ({ p, d: distanceMiles(position, p) }))
            .sort((a, b) => a.d - b.d)
            .map((x) => x.p)
        }
        return rows.sort((a, b) => b.score - a.score)
      case 'score':
        return rows.sort((a, b) => b.score - a.score)
      case 'value':
        return rows.sort((a, b) => (b.opportunityValue ?? 0) - (a.opportunityValue ?? 0))
      case 'recent':
        return rows.sort((a, b) => (b.lastVisitAt ?? 0) - (a.lastVisitAt ?? 0))
    }
  }, [scoped, deferredQuery, status, sort, position])

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <TopBar
        title="Leads"
        subtitle={`${list.length} of ${scoped.length}`}
        below={
          <div className="space-y-2.5">
            <label className="relative block">
              <span className="sr-only">Search leads</span>
              <span className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-ink-mute">
                <IconSearch />
              </span>
              <input
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                type="search"
                inputMode="search"
                enterKeyHint="search"
                placeholder="Address or name"
                data-tour="leads-search"
                className="field h-[48px] pl-11 pr-3 md:max-w-md"
              />
            </label>
            <div className="snap-x-row" data-tour="leads-sort">
              {SORTS.map((s) => (
                <Chip
                  key={s.key}
                  size="sm"
                  selected={sort === s.key}
                  onClick={() => setSort(s.key)}
                >
                  {s.label}
                </Chip>
              ))}
              <span className="mx-1 w-px shrink-0 self-stretch bg-line" />
              {STATUS_FILTERS.map((s) => (
                <Chip key={s} size="sm" selected={status === s} onClick={() => setStatus(s)}>
                  {s === 'all' ? 'All' : STATUS_LABEL[s]}
                </Chip>
              ))}
            </div>
          </div>
        }
      />

      {/*
        Phone: one full-width list, tap to push a detail screen.
        Tablet+: the same list beside a live preview pane — the extra width buys
        context (who, history, next action) rather than wider rows.
      */}
      <div className="flex min-h-0 flex-1">
        <div className="flex min-h-0 min-w-0 flex-1 flex-col lg:max-w-[460px] lg:border-r lg:border-line">
          <VirtualList
            items={list}
            itemHeight={ROW_HEIGHT}
            className="pad-nav bg-surface"
            renderItem={(p, i) => (
              <PropertyRow
                /* The tour points at the first row, whichever lead it is. */
                tour={i === 0 ? 'leads-row' : undefined}
                property={p}
                position={position}
                showDistance={sort === 'nearest'}
                onPreview={isDesktop ? setPreviewId : undefined}
                active={p.id === previewId}
              />
            )}
            empty={
              <div className="grid place-items-center px-8 py-14 text-center text-[14px] text-ink-mute">
                No leads match those filters.
              </div>
            }
          />
        </div>

        {isDesktop && (
          <aside className="hidden min-w-0 flex-1 bg-surface-sunk lg:block">
            {preview ? (
              <div className="scroll-pane p-5">
                <div className="content-col">
                  <PropertyPeek
                    property={preview}
                    position={position}
                    onOpenFull={() => nav(`/property/${preview.id}`)}
                  />
                </div>
              </div>
            ) : (
              <div className="grid h-full place-items-center p-10 text-center text-[14px] text-ink-mute">
                Select a lead to preview it here.
              </div>
            )}
          </aside>
        )}
      </div>
    </div>
  )
}
