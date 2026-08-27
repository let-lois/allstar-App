import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { Property } from '../../types'
import { distanceMiles, formatDistance } from '../../lib/geo'
import { STATUS_COLOR } from '../../data/outcomes'
import { gmapsConfigured, loadGmaps } from '../../lib/gmaps'

/**
 * Search on the map screen.
 *
 * Leads first, addresses second, and that order is the whole design.
 *
 * The daily problem is not "where is 1200 Elm Street" — a rep can pan to that.
 * It is "which of my sixty-nine leads is the one I am looking for", and until now
 * the only answer was scrolling a list. So typing searches the leads already on
 * the device: instant, no network, and it matches the house number, the street,
 * the town and the contact's name, because a rep looking for the Delgado house
 * does not necessarily remember its number.
 *
 * Only when nothing local matches does it offer to look the text up as an
 * address and move the map there. That ordering matters for a reason beyond
 * usefulness: the lead search costs nothing and works in a dead zone, and the
 * address lookup is billed per session and needs signal. Putting the free,
 * offline, more-likely-correct answer first is not a compromise.
 *
 * It replaces the property-count pill rather than adding a row. On a 360px phone
 * the map is the screen, and a third band of chrome over it would cost more than
 * the count was worth — so the count moved into the placeholder, where it is
 * still visible until the moment someone starts typing.
 */

/** Local matches shown. Beyond this, refine the query rather than scroll a popup. */
const MAX_LEADS = 6
/** Below this, an address lookup matches half the country. */
const MIN_PLACE_CHARS = 4
const DEBOUNCE = 320

interface PlaceHit {
  main: string
  secondary: string
  resolve: () => Promise<{ lat: number; lng: number } | null>
}

/** Everything about a lead worth matching against, lowercased once. */
const haystack = (p: Property) =>
  [p.address1, p.city, p.zip, ...p.contacts.map((c) => c.name)]
    .filter(Boolean)
    .join(' ')
    .toLowerCase()

export function MapSearch({
  properties,
  position,
  count,
  onPickLead,
  onPickPlace,
}: {
  properties: Property[]
  position?: { lat: number; lng: number } | null
  /** Shown in the placeholder, so the count survives losing its own pill. */
  count: number
  onPickLead: (id: string) => void
  onPickPlace: (at: { lat: number; lng: number }) => void
}) {
  const [q, setQ] = useState('')
  const [open, setOpen] = useState(false)
  const [places, setPlaces] = useState<PlaceHit[]>([])
  const [placesOff, setPlacesOff] = useState(!gmapsConfigured())
  const seq = useRef(0)
  const timer = useRef<number | null>(null)

  const query = q.trim().toLowerCase()

  const leads = useMemo(() => {
    if (query.length < 2) return []
    const hits = properties.filter((p) => haystack(p).includes(query))
    // Nearest first when we know where the rep is: among several matches on one
    // street, the relevant one is almost always the closest.
    if (position) {
      hits.sort((a, b) => distanceMiles(position, a) - distanceMiles(position, b))
    }
    return hits.slice(0, MAX_LEADS)
  }, [properties, query, position])

  /*
    Addresses are only looked up when the leads came back empty. A query that
    already matched a lead does not need Google, and asking anyway would spend a
    billed session to answer a question that is already answered.
  */
  const wantPlaces = !placesOff && query.length >= MIN_PLACE_CHARS && leads.length === 0

  const searchPlaces = useCallback(async (input: string) => {
    const mine = ++seq.current
    try {
      const { AutocompleteSessionToken, AutocompleteSuggestion } =
        (await google.maps.importLibrary('places')) as google.maps.PlacesLibrary
      const { suggestions } = await AutocompleteSuggestion.fetchAutocompleteSuggestions({
        input,
        sessionToken: new AutocompleteSessionToken(),
        includedRegionCodes: ['us'],
      })
      if (mine !== seq.current) return
      setPlaces(
        suggestions.slice(0, 4).flatMap((s) => {
          const p = s.placePrediction
          if (!p) return []
          return [
            {
              main: p.mainText?.toString() ?? p.text.toString(),
              secondary: p.secondaryText?.toString() ?? '',
              resolve: async () => {
                const place = p.toPlace()
                await place.fetchFields({ fields: ['location'] })
                const loc = place.location
                return loc ? { lat: loc.lat(), lng: loc.lng() } : null
              },
            },
          ]
        }),
      )
    } catch {
      // No signal, no quota, rejected key. The lead search still works, which is
      // the part that matters, so this goes quiet rather than complaining.
      if (mine === seq.current) {
        setPlacesOff(true)
        setPlaces([])
      }
    }
  }, [])

  useEffect(() => {
    if (timer.current) window.clearTimeout(timer.current)
    if (!wantPlaces) {
      setPlaces([])
      return
    }
    timer.current = window.setTimeout(
      () => void loadGmaps().then(() => searchPlaces(q.trim())).catch(() => setPlacesOff(true)),
      DEBOUNCE,
    )
    return () => {
      if (timer.current) window.clearTimeout(timer.current)
    }
  }, [wantPlaces, q, searchPlaces])

  const clear = () => {
    setQ('')
    setOpen(false)
    setPlaces([])
  }

  const showResults = open && query.length >= 2

  return (
    <div className="relative min-w-0 flex-1">
      {/*
        `z-20` on the field itself, above the dismiss layer below. Without it the
        invisible full-screen backdrop covers the clear button, so tapping ✕ with
        results open lands on the backdrop and does nothing visible — the second
        time an unpainted overlay has quietly eaten taps in this codebase.
      */}
      <div className="relative z-20 flex min-h-tap items-center gap-1.5 rounded-full border border-line bg-surface/95 px-3 shadow-card backdrop-blur">
        <span aria-hidden className="shrink-0 text-[13px] text-ink-mute">
          ⌕
        </span>
        <input
          value={q}
          onChange={(e) => {
            setQ(e.target.value)
            setOpen(true)
          }}
          onFocus={() => setOpen(true)}
          onKeyDown={(e) => {
            if (e.key === 'Escape') clear()
          }}
          type="search"
          enterKeyHint="search"
          aria-label="Search leads and addresses"
          placeholder={`Search ${count} ${count === 1 ? 'lead' : 'leads'}`}
          /*
            `self-stretch`, not vertical padding. The pill around this is 44px, but
            padding on the input left it 36px tall — so the field *looked* like a
            thumb target while the part that actually takes a tap was smaller than
            one, and a thumb landing near the pill's edge focused nothing.
          */
          className="min-w-0 flex-1 self-stretch bg-transparent text-[13.5px] font-medium text-ink outline-none placeholder:font-semibold placeholder:text-ink-mute"
        />
        {q && (
          <button
            onClick={clear}
            aria-label="Clear search"
            className="focusable -mr-1 grid h-9 w-9 shrink-0 place-items-center rounded-full text-[15px] text-ink-mute"
          >
            ✕
          </button>
        )}
      </div>

      {showResults && (
        <>
          <button
            aria-hidden
            tabIndex={-1}
            onClick={() => setOpen(false)}
            className="fixed inset-0 z-10 cursor-default"
          />
          <div className="absolute inset-x-0 z-20 mt-1.5 overflow-hidden card shadow-raise">
            {leads.length > 0 && (
              <ul aria-label="Matching leads">
                {leads.map((p) => (
                  <li key={p.id}>
                    <button
                      onClick={() => {
                        onPickLead(p.id)
                        setOpen(false)
                      }}
                      className="flex min-h-tap w-full items-center gap-2.5 border-b border-line-soft px-3 py-2 text-left active:bg-surface-field"
                    >
                      <span
                        aria-hidden
                        className="h-7 w-1.5 shrink-0 rounded-full"
                        style={{ backgroundColor: STATUS_COLOR[p.status] }}
                      />
                      <span className="min-w-0 flex-1">
                        <span className="block truncate text-[14px] font-semibold leading-tight">
                          {p.address1}
                        </span>
                        <span className="block truncate text-[12px] leading-tight text-ink-mute">
                          {p.contacts[0]?.name ?? 'No contact'}
                          {p.city ? ` · ${p.city}` : ''}
                        </span>
                      </span>
                      {position && (
                        <span className="nums shrink-0 text-[12px] font-semibold text-ink-soft">
                          {formatDistance(distanceMiles(position, p))}
                        </span>
                      )}
                    </button>
                  </li>
                ))}
              </ul>
            )}

            {places.length > 0 && (
              <>
                {/*
                  Labelled, because these are a different kind of answer: tapping
                  one moves the map somewhere there is no lead. Without the label
                  it reads as "we found your lead" and it has not.
                */}
                <p className="eyebrow border-b border-line-soft bg-surface-sunk px-3 py-1.5">
                  Not a lead — go to this address
                </p>
                <ul aria-label="Matching addresses">
                  {places.map((hit, i) => (
                    <li key={`${hit.main}-${i}`}>
                      <button
                        onClick={() => {
                          void hit.resolve().then((at) => {
                            if (at) onPickPlace(at)
                          })
                          setOpen(false)
                        }}
                        className="flex min-h-tap w-full flex-col items-start justify-center gap-0.5 border-b border-line-soft px-3 py-2 text-left last:border-0 active:bg-surface-field"
                      >
                        <span className="text-[14px] font-semibold leading-tight">{hit.main}</span>
                        {hit.secondary && (
                          <span className="text-[12px] leading-tight text-ink-mute">
                            {hit.secondary}
                          </span>
                        )}
                      </button>
                    </li>
                  ))}
                </ul>
              </>
            )}

            {leads.length === 0 && places.length === 0 && (
              <p className="px-3 py-3 text-[13px] text-ink-mute">
                {placesOff
                  ? 'No lead matches that.'
                  : query.length < MIN_PLACE_CHARS
                    ? 'No lead matches that yet — keep typing to search addresses.'
                    : 'No lead matches that.'}
              </p>
            )}
          </div>
        </>
      )}
    </div>
  )
}
