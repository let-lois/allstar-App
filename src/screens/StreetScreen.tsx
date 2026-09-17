import { IconBack, IconChevron } from '../components/nav/icons'
import { useMemo, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { TopBar } from '../components/nav/TopBar'
import { StatusPill } from '../components/ui/StatusPill'
import { StreetView } from '../components/property/StreetView'
import { Button } from '../components/ui/Button'
import { Chip } from '../components/ui/Chip'
import { useAppStore, useScopedProperties } from '../store/useAppStore'
import { houseNumberOf, streetOf } from '../lib/route'
import { distanceMiles, formatDistance } from '../lib/geo'
import { relative } from '../lib/format'
import type { Property } from '../types'

/**
 * One street, door by door.
 *
 * The map answers "where is the work" and the leads list answers "what is in the
 * pipeline". Neither answers the question a rep actually has while standing on a
 * pavement: *which of these houses have I done, and which is next up this side
 * of the road?* On the map that is a scatter of dots whose numbers are not
 * shown; in the list it is a set of rows sorted by distance, which is not the
 * order anyone walks.
 *
 * So this screen has exactly one organising idea: **house-number order down one
 * street**, with the state of each door on the row. That is how the work is
 * really done, and it is the one view the app did not have.
 *
 * ## Why the imagery is one house at a time
 *
 * Street View is a paid, per-request API. A street of forty doors rendered with
 * a thumbnail each is forty billable requests every time somebody opens the
 * screen, for pictures nobody looked at — and this codebase has already had one
 * argument about a geocoding bill nobody saw coming. So the list itself costs
 * nothing, and the photo loads for the one door a rep has tapped. Walking the
 * street with the prev/next buttons costs one request per house actually looked
 * at, which is the same bargain the lead screen already makes.
 */

type Bucket = 'all' | 'todo' | 'done'

interface Door {
  property: Property
  number: number
  knocked: boolean
}

export function StreetScreen() {
  const nav = useNavigate()
  const scoped = useScopedProperties()
  const position = useAppStore((s) => s.position)

  /*
    Streets, each with enough of a summary to choose between them.

    Sorted by distance from the rep when there is a position, because the street
    somebody wants is almost always the one they are standing on. Falling back to
    door count rather than alphabetically: with no fix, the biggest street is a
    better guess than the one starting with A.
  */
  const streets = useMemo(() => {
    const byStreet = new Map<string, Property[]>()
    for (const p of scoped) {
      const street = streetOf(p.address1)
      if (!street) continue
      const list = byStreet.get(street)
      if (list) list.push(p)
      else byStreet.set(street, [p])
    }
    const out = [...byStreet.entries()].map(([name, list]) => {
      const knocked = list.filter((p) => p.lastVisitAt).length
      const near = position
        ? Math.min(
            ...list
              .filter((p) => Number.isFinite(p.lat) && Number.isFinite(p.lng))
              .map((p) => distanceMiles(position, p)),
          )
        : Infinity
      return { name, list, knocked, todo: list.length - knocked, near }
    })
    out.sort((a, b) =>
      Number.isFinite(a.near) && Number.isFinite(b.near)
        ? a.near - b.near
        : b.list.length - a.list.length,
    )
    return out
  }, [scoped, position])

  const [picked, setPicked] = useState<string | null>(null)
  const street = streets.find((s) => s.name === picked) ?? streets[0]

  const [bucket, setBucket] = useState<Bucket>('all')
  const [focusId, setFocusId] = useState<string | null>(null)

  /*
    The doors, in the order they are walked.

    Ascending house number, and ties broken by the full address so "1420-B"
    lands beside "1420" deterministically rather than wherever the source list
    happened to put it.
  */
  const doors = useMemo<Door[]>(() => {
    if (!street) return []
    return street.list
      .map((property) => ({
        property,
        number: houseNumberOf(property.address1),
        knocked: !!property.lastVisitAt,
      }))
      .sort((a, b) => a.number - b.number || a.property.address1.localeCompare(b.property.address1))
  }, [street])

  const shown = useMemo(
    () =>
      doors.filter((d) =>
        bucket === 'all' ? true : bucket === 'todo' ? !d.knocked : d.knocked,
      ),
    [doors, bucket],
  )

  const focusIndex = shown.findIndex((d) => d.property.id === focusId)
  const focus = focusIndex >= 0 ? shown[focusIndex] : null

  if (streets.length === 0) {
    return (
      <>
        <TopBar
          title="Street"
          right={
            <button
              onClick={() => nav('/map')}
              className="focusable metal metal-quiet min-h-tap rounded-full px-3.5 text-[12.5px] font-semibold"
            >
              Map
            </button>
          }
        />
        <div className="scroll-pane">
          <p className="p-6 text-sm text-ink-mute">
            No leads with a street address yet. Once leads are imported or added at a
            door, this screen lists them house by house.
          </p>
        </div>
      </>
    )
  }

  return (
    <>
      <TopBar
        title={street?.name ?? 'Street'}
        subtitle={`${doors.length} doors`}
        /*
          The way back to the map, in the same words the map uses to get here.
          Not a plain back arrow: a rep arrives on this screen from the map's own
          segmented control, and "back" from a view is a weaker promise than the
          name of the view you land on.
        */
        right={
          <button
            onClick={() => nav('/map')}
            className="focusable metal metal-quiet min-h-tap rounded-full px-3.5 text-[12.5px] font-semibold"
          >
            Map
          </button>
        }
      />

      <div className="scroll-pane pad-nav bg-surface-sunk">
        {/* --- which street ------------------------------------------------- */}
        <div className="snap-x-row bg-surface px-3 py-2" data-testid="street-picker">
          {streets.map((s) => (
            <Chip
              key={s.name}
              size="sm"
              selected={s.name === street?.name}
              onClick={() => {
                setPicked(s.name)
                setFocusId(null)
              }}
            >
              {s.name}
              <span className="ml-1.5 text-[11px] opacity-70">
                {s.todo}/{s.list.length}
              </span>
            </Chip>
          ))}
        </div>

        {/*
          The count a rep is actually tracking. "12 to go" is the number that
          decides whether they finish the street before lunch; the total is
          context for it, not the headline.
        */}
        {street && (
          <div className="flex flex-wrap items-baseline gap-x-3 bg-surface px-4 pb-3">
            <span className="text-[22px] font-semibold leading-none">
              {street.todo} to go
            </span>
            <span className="text-[13px] text-ink-mute">
              {street.knocked} knocked · {street.list.length} doors
              {Number.isFinite(street.near) ? ` · nearest ${formatDistance(street.near)}` : ''}
            </span>
          </div>
        )}

        <div className="snap-x-row px-3 py-2">
          {(
            [
              ['all', `All ${doors.length}`],
              ['todo', `Not knocked ${doors.filter((d) => !d.knocked).length}`],
              ['done', `Knocked ${doors.filter((d) => d.knocked).length}`],
            ] as const
          ).map(([key, label]) => (
            <Chip key={key} size="sm" selected={bucket === key} onClick={() => setBucket(key)}>
              {label}
            </Chip>
          ))}
        </div>

        {/* --- the focused door, with its photo ----------------------------- */}
        {focus && (
          <section className="mx-3 mb-3 rounded-card bg-surface p-3" data-testid="street-focus">
            <StreetView
              lat={focus.property.lat}
              lng={focus.property.lng}
              address={focus.property.address1}
            />
            <div className="mt-2 flex flex-wrap items-center gap-2">
              <span className="text-[15px] font-semibold">{focus.property.address1}</span>
              <StatusPill status={focus.property.status} size="sm" />
            </div>
            <div className="mt-2.5 flex flex-wrap gap-2">
              <Button size="sm" onClick={() => nav(`/property/${focus.property.id}?start=1`)}>
                Knock this door
              </Button>
              <Button
                size="sm"
                variant="secondary"
                onClick={() => nav(`/property/${focus.property.id}`)}
              >
                Open lead
              </Button>
              {/*
                Walking the street without going back to the list. Bounded by the
                filtered set, so "next" inside "Not knocked" skips the doors that
                are done — which is the whole point of standing on the pavement
                with the filter on.
              */}
              <Button
                size="sm"
                variant="ghost"
                disabled={focusIndex <= 0}
                onClick={() => setFocusId(shown[focusIndex - 1]?.property.id ?? null)}
                icon={<IconBack />}
              >
                Prev
              </Button>
              <Button
                size="sm"
                variant="ghost"
                disabled={focusIndex >= shown.length - 1}
                onClick={() => setFocusId(shown[focusIndex + 1]?.property.id ?? null)}
              >
                Next
                <span className="icon-xs grid place-items-center">
                  <IconChevron />
                </span>
              </Button>
            </div>
          </section>
        )}

        {/* --- the doors ---------------------------------------------------- */}
        {shown.length === 0 ? (
          <p className="px-4 py-6 text-sm text-ink-mute">
            {bucket === 'todo'
              ? 'Every door on this street has been knocked.'
              : 'No doors on this street have been knocked yet.'}
          </p>
        ) : (
          <ul className="mx-3 divide-y divide-line-soft overflow-hidden rounded-card bg-surface">
            {shown.map((d) => (
              <li key={d.property.id}>
                <button
                  onClick={() => setFocusId(d.property.id)}
                  aria-pressed={d.property.id === focusId}
                  className={`focusable flex w-full items-center gap-3 px-3 py-2.5 text-left ${
                    d.property.id === focusId ? 'bg-surface-tint' : ''
                  }`}
                  data-testid="street-door"
                >
                  {/*
                    The number, large and first. It is what a rep reads off a
                    kerb, and on this screen the rest of the address is the same
                    for every row — so leading with the full address would put
                    the one distinguishing part at the end of a truncated line.
                  */}
                  <span className="nums w-14 shrink-0 text-[17px] font-semibold tabular-nums">
                    {d.number || '—'}
                  </span>
                  <span className="min-w-0 flex-1">
                    <StatusPill status={d.property.status} size="sm" />
                    <span className="mt-0.5 block truncate text-[12.5px] text-ink-mute">
                      {d.knocked
                        ? `Knocked ${relative(d.property.lastVisitAt)}${
                            d.property.lastOutcome === 'no_answer' ? ' · no answer' : ''
                          }`
                        : 'Not knocked'}
                    </span>
                  </span>
                  {/*
                    A shape, not a shade. The same reasoning as the map's
                    no-answer bar: this is read outdoors, and the difference
                    between an unknocked door and one nobody answered has to
                    survive sunlight and colourblindness.
                  */}
                  <span
                    aria-hidden
                    className={`w-4 shrink-0 text-center text-[15px] font-bold ${
                      !d.knocked
                        ? 'text-ink-faint'
                        : d.property.lastOutcome === 'no_answer'
                          ? 'text-warn'
                          : 'text-good'
                    }`}
                  >
                    {!d.knocked ? '·' : d.property.lastOutcome === 'no_answer' ? '—' : '✓'}
                  </span>
                </button>
              </li>
            ))}
          </ul>
        )}
      </div>
    </>
  )
}
