import { IconFilter, IconList } from '../components/nav/icons'
import { useDeferredValue, useMemo, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { TopBar } from '../components/nav/TopBar'
import { Chip } from '../components/ui/Chip'
import { Button } from '../components/ui/Button'
import { BottomSheet } from '../components/ui/BottomSheet'
import { FilterSection } from '../components/map/FilterSheet'
import { PropertyRow } from '../components/property/PropertyRow'
import { PropertyPeek } from '../components/property/PropertyPeek'
import { VirtualList } from '../components/ui/VirtualList'
import { EmptyState } from '../components/ui/EmptyState'
import { useAppStore, useScopedProperties } from '../store/useAppStore'
import { VISITED_WINDOWS, matchesRep, matchesVisited, type VisitedWindow } from '../lib/leadFilter'
import { useIsDesktop } from '../lib/useMediaQuery'
import { distanceMiles } from '../lib/geo'
import { IconSearch } from '../components/nav/icons'
import type { LeadStatus, Property } from '../types'
import { STATUS_LABEL } from '../data/outcomes'
import { leadValue } from '@allstar/core/deals'

/*
  No "Best score": every lead's score is the 50 it was created with — nothing
  computes one (docs/sales-data-audit.md) — so sorting by it was sorting by
  nothing. It comes back when there is a real score to sort on.
*/
type Sort = 'nearest' | 'recent' | 'value'

const SORTS: { key: Sort; label: string }[] = [
  { key: 'nearest', label: 'Nearest' },
  { key: 'value', label: 'Value' },
  { key: 'recent', label: 'Recent' },
]

const STATUS_FILTERS: (LeadStatus | 'all')[] = [
  'all',
  'new',
  'contacted',
  'follow_up',
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
  const [visited, setVisited] = useState<VisitedWindow>('any')
  /*
    Whose leads. Meaningless to a field rep — the list is already only theirs —
    so the control is only rendered for the office roles that see everybody's,
    which is exactly who needs it.
  */
  const [repFilter, setRepFilter] = useState<string>('all')
  const timezone = useAppStore((s) => s.timezone)
  const team = useAppStore((s) => s.team)
  const user = useAppStore((s) => s.user)
  const seesEveryone = user?.role !== 'field_rep'
  const reps = useMemo(
    () => team.filter((m) => m.active && m.role !== 'super_admin'),
    [team],
  )
  const [previewId, setPreviewId] = useState<string | null>(null)
  const [filtersOpen, setFiltersOpen] = useState(false)
  /* How many questions have an answer other than the default — the number on the button. */
  const activeFilters =
    (status !== 'all' ? 1 : 0) + (visited !== 'any' ? 1 : 0) + (seesEveryone && repFilter !== 'all' ? 1 : 0)
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
    // Both through the shared predicates, so this list, the console and the map
    // answer the same question the same way. See leadFilter.ts.
    if (visited !== 'any') rows = rows.filter((p) => matchesVisited(p, visited, timezone))
    if (seesEveryone && repFilter !== 'all') rows = rows.filter((p) => matchesRep(p, repFilter))
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
        // No location yet: the order they are in, not a score that is 50 for all.
        return rows
      case 'value':
        return rows.sort((a, b) => (leadValue(b) ?? 0) - (leadValue(a) ?? 0))
      case 'recent':
        return rows.sort((a, b) => (b.lastVisitAt ?? 0) - (a.lastVisitAt ?? 0))
    }
  }, [scoped, deferredQuery, status, visited, repFilter, seesEveryone, timezone, sort, position])

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <TopBar
        title="Leads"
        subtitle={`${list.length} of ${scoped.length}`}
        /*
          The way to the rep's lists. Not a sixth tab — the bar is full and a
          list is a way of working the leads, so it lives with them.
        */
        right={
          <button
            onClick={() => nav('/lists')}
            data-testid="open-lists"
            aria-label="Lists"
            title="Lists"
            className="icon-sm focusable grid min-h-[44px] w-11 place-items-center rounded-lg text-accent"
          >
            <IconList />
          </button>
        }
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
            {/*
              One row that wraps, and a way into the rest.

              This was two horizontal rails holding eighteen chips between them
              on a rep's phone — sorts, nine statuses, six visit windows — and
              "All" was clipped at the right edge of a 390px screen with nothing
              to say more lay past it. The map had the same rail and the same
              fix: keep the question a rep answers on arriving in plain sight,
              and put everything else one tap away in a sheet with headings.
              Here that question is the sort. Four chips wrap rather than
              scroll, and the Filters button is pinned so it is never the thing
              that got pushed off.
            */}
            {/*
              Filters pinned at the top right, the sort chips wrapping beside it.
              Wrapped as one group, four chips on a 375pt phone pushed Filters
              onto a line of its own, a whole band of chrome for one button; a
              sideways-scrolling rail would hide a sort option behind a swipe
              (verify:leadsheet forbids one). So the chips wrap in their own
              column and the button never moves.
            */}
            <div className="flex items-start gap-2" data-testid="leads-header-row">
              <div className="flex min-w-0 flex-1 flex-wrap gap-2" data-tour="leads-sort" role="group" aria-label="Sort">
                {SORTS.map((s) => (
                  <Chip key={s.key} size="sm" selected={sort === s.key} onClick={() => setSort(s.key)}>
                    {s.label}
                  </Chip>
                ))}
              </div>
              <button
                onClick={() => setFiltersOpen(true)}
                data-testid="leads-filters"
                aria-label={activeFilters ? `Filters, ${activeFilters} active` : 'Filters'}
                title={activeFilters ? `Filters, ${activeFilters} active` : 'Filters'}
                className="icon-sm focusable press metal metal-quiet flex min-h-[44px] shrink-0 items-center justify-center gap-1 rounded-pill px-3 text-ink-soft"
              >
                <IconFilter />
                {activeFilters > 0 && (
                  <span className="nums rounded-full bg-ink/10 px-1.5 py-0.5 text-[11px] font-bold text-accent-strong">
                    {activeFilters}
                  </span>
                )}
              </button>
            </div>
          </div>
        }
      />

      <BottomSheet
        open={filtersOpen}
        onClose={() => setFiltersOpen(false)}
        title="Filters"
        detents={[0.86]}
        footer={
          <div className="flex gap-2">
            <Button
              variant="secondary"
              size="lg"
              className="shrink-0"
              disabled={activeFilters === 0}
              onClick={() => {
                setStatus('all')
                setVisited('any')
                setRepFilter('all')
              }}
            >
              Clear
            </Button>
            <Button size="lg" full onClick={() => setFiltersOpen(false)}>
              <span>
                Show <span className="nums">{list.length}</span>
                {list.length === 1 ? ' lead' : ' leads'}
              </span>
            </Button>
          </div>
        }
      >
        <div className="space-y-5 pt-1" data-testid="leads-filter-sheet">
          <FilterSection title="Status" hint={status === 'all' ? 'Every stage.' : 'Only this stage.'}>
            <div role="group" aria-label="Status" className="flex flex-wrap gap-2">
              {STATUS_FILTERS.map((s) => (
                <Chip key={s} size="sm" selected={status === s} onClick={() => setStatus(s)}>
                  {s === 'all' ? 'All' : STATUS_LABEL[s]}
                </Chip>
              ))}
            </div>
          </FilterSection>

          <FilterSection title="Last visit" hint="One answer: a door cannot be both unknocked and knocked today.">
            <div role="group" aria-label="Last visit" className="flex flex-wrap gap-2" data-testid="leads-visited">
              {VISITED_WINDOWS.map((w) => (
                <Chip key={w.key} size="sm" selected={visited === w.key} onClick={() => setVisited(w.key)}>
                  {w.key === 'any' ? 'Any visit' : w.label}
                </Chip>
              ))}
            </div>
          </FilterSection>

          {/*
            Whose leads. Meaningless to a field rep — the list is already only
            theirs — so the section exists only for the office roles that see
            everybody's, which is exactly who needs it.
          */}
          {seesEveryone && reps.length > 0 && (
            <FilterSection title="Whose" hint="Everyone, nobody yet, or one rep.">
              <div role="group" aria-label="Whose" className="flex flex-wrap gap-2">
                <Chip size="sm" selected={repFilter === 'all'} onClick={() => setRepFilter('all')}>
                  Everyone
                </Chip>
                <Chip size="sm" selected={repFilter === 'unassigned'} onClick={() => setRepFilter('unassigned')}>
                  Unassigned
                </Chip>
                {reps.map((r) => (
                  <Chip key={r.id} size="sm" selected={repFilter === r.id} onClick={() => setRepFilter(r.id)}>
                    {r.name}
                  </Chip>
                ))}
              </div>
            </FilterSection>
          )}
        </div>
      </BottomSheet>

      {/*
        Phone: one full-width list, tap to push a detail screen.
        Tablet+: the same list beside a live preview pane — the extra width buys
        context (who, history, next action) rather than wider rows.
      */}
      <div className="flex min-h-0 flex-1">
        <div className="flex min-h-0 min-w-0 flex-1 flex-col lg:max-w-[460px] lg:border-r lg:border-line">
          {/*
            The tour anchors the list, not a row in it.

            `VirtualList` renders a window: row zero exists only while the list
            is scrolled to the top, and not at all when a filter empties it. An
            anchor that comes and goes with the scroll position is an anchor the
            tutorial skips for reasons nobody can reproduce.
          */}
          <VirtualList
            data-tour="leads-row"
            items={list}
            itemHeight={ROW_HEIGHT}
            className="pad-nav bg-surface"
            renderItem={(p) => (
              <PropertyRow
                property={p}
                position={position}
                showDistance={sort === 'nearest'}
                onPreview={isDesktop ? setPreviewId : undefined}
                active={p.id === previewId}
              />
            )}
            empty={
              /*
                Two different situations, and they were being told the same
                thing. An account with no leads at all was shown "No leads match
                those filters" — which sends somebody to go and change filters
                that are not the problem. The console's version of this list has
                always drawn the distinction; this is the same distinction, in
                the rep's words.
              */
              <div className="grid place-items-center px-2 py-8">
                {scoped.length === 0 ? (
                  <EmptyState
                    testId="leads-empty"
                    title="No leads here yet"
                    body="That is normal on a new account. Your office adds them, or you can add one from the map."
                    action={
                      <Button variant="secondary" onClick={() => nav('/map')}>
                        Open the map
                      </Button>
                    }
                  />
                ) : (
                  <EmptyState
                    testId="leads-empty"
                    title="No leads match"
                    body={query.trim() ? `Nothing matches “${query.trim()}” with these filters.` : 'Nothing matches these filters.'}
                    action={
                      <Button
                        variant="secondary"
                        onClick={() => {
                          setQuery('')
                          setStatus('all')
                          setVisited('any')
                          setRepFilter('all')
                        }}
                      >
                        Clear search and filters
                      </Button>
                    }
                  />
                )}
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
