import { useCallback, useEffect, useRef, useState } from 'react'
import { Field } from '../ui/Input'
import { gmapsConfigured, loadGmaps } from '../../lib/gmaps'
import { fromPlaces, partsToAddress } from '../../lib/address'

/**
 * Address entry with suggestions, for a rep standing in front of a house.
 *
 * The shape of this component is decided by one fact: it has to work with no
 * signal. So it is a plain text input that *sometimes* offers suggestions —
 * never a search box that stops accepting typing when the network goes. If
 * Places is unconfigured, unreachable, or simply slow, the rep types the address
 * exactly as they did before and nothing tells them off.
 *
 * Why the data API rather than Google's own `PlaceAutocompleteElement`: that
 * component brings its own markup and its own idea of how big a row should be.
 * This app has spent a lot of effort on 44px tap targets and one-handed reach,
 * and a widget that ignores them on the one screen a rep uses outdoors, in
 * gloves, is not a saving. Rendering the list ourselves costs about forty lines.
 *
 * What a pick is worth, beyond saving typing: the selected place carries its own
 * coordinates and a *structured* address. Before this, the screen wrote a
 * hardcoded city, state and ZIP onto every lead added from the field, and it
 * needed GPS to place a pin at all — so a rep whose phone had blocked location
 * could not add a lead. A picked address solves both, because Google already
 * knows where it is.
 *
 * Cost discipline, because this is billed per keystroke if you let it be:
 * requests wait for a pause in typing, need three characters, are limited to US
 * addresses, and share one session token until a pick ends the session. Typing
 * an address is one billable session, not fifteen.
 */

/** A resolved address. Every field is real rather than assumed. */
export interface PickedAddress {
  address1: string
  city: string
  state: string
  zip: string
  lat: number
  lng: number
  formatted: string
}

/** Milliseconds of quiet before asking Google. */
const DEBOUNCE = 320
/** Below this a query matches half the country and costs the same as a good one. */
const MIN_CHARS = 3
/** Suggestions shown. More than this is a scroll inside a dropdown on a phone. */
const MAX_SUGGESTIONS = 5
/** Bias radius around the rep, in metres. A rep is walking, not flying. */
const NEAR_RADIUS = 40_000

interface Suggestion {
  main: string
  secondary: string
  /** Resolves the full address. Deliberately lazy — this is the billable call. */
  resolve: () => Promise<PickedAddress | null>
}

/**
 * A picked suggestion, as the four fields this app stores.
 *
 * The preference order that turns Google's typed components into those fields
 * moved to lib/address.ts when the map learned to ask for the address under a
 * tapped pin: that answer arrives in a different shape with the same meaning,
 * and two copies of "which component is the city" is the kind of pair that
 * agrees on the day it is written and disagrees a year later.
 */
function componentsToAddress(
  parts: google.maps.places.AddressComponent[],
  location: google.maps.LatLng | null,
  formatted: string,
): PickedAddress | null {
  if (!location) return null
  const fields = partsToAddress(fromPlaces(parts))
  // No street means this is a city or a region, not a door — `partsToAddress`
  // refuses those, so that a lead is never saved with "Austin" as its address.
  if (!fields) return null
  return { ...fields, lat: location.lat(), lng: location.lng(), formatted }
}

export function AddressAutocomplete({
  value,
  onChange,
  onPick,
  near,
  label = 'Address',
  hint,
  autoFocus = true,
}: {
  value: string
  onChange: (v: string) => void
  /** Fired when a suggestion resolves. Not fired for typed-only input. */
  onPick: (a: PickedAddress) => void
  /** The rep's position, used to bias results towards where they are standing. */
  near?: { lat: number; lng: number } | null
  label?: string
  hint?: string
  /**
   * Whether to take the keyboard on mount. On by default, which is right on the
   * Add-lead *screen*: it exists for nothing else, so a rep arrives ready to
   * type.
   *
   * The map's sheet turns it off. There the rep has just tapped a house and the
   * pin is the confirmation they are looking for — throwing a keyboard over the
   * map to cover it, unasked, would take away the one thing the tap was for.
   */
  autoFocus?: boolean
}) {
  const [suggestions, setSuggestions] = useState<Suggestion[]>([])
  const [open, setOpen] = useState(false)
  const [resolving, setResolving] = useState(false)
  /** Set once Places has failed, so we stop retrying on every keystroke. */
  const [unavailable, setUnavailable] = useState(!gmapsConfigured())

  const session = useRef<google.maps.places.AutocompleteSessionToken | null>(null)
  /** Guards against a slow response overwriting a newer one. */
  const seq = useRef(0)
  const timer = useRef<number | null>(null)

  const search = useCallback(
    async (input: string) => {
      const mine = ++seq.current
      try {
        const { AutocompleteSessionToken, AutocompleteSuggestion } =
          (await google.maps.importLibrary('places')) as google.maps.PlacesLibrary
        session.current ??= new AutocompleteSessionToken()

        const { suggestions: raw } = await AutocompleteSuggestion.fetchAutocompleteSuggestions({
          input,
          sessionToken: session.current,
          includedRegionCodes: ['us'],
          // Doors only. Without this a rep gets restaurants and parks.
          includedPrimaryTypes: ['street_address', 'premise', 'subpremise'],
          ...(near
            ? { locationBias: { center: near, radius: NEAR_RADIUS } }
            : {}),
        })
        if (mine !== seq.current) return

        setSuggestions(
          raw.slice(0, MAX_SUGGESTIONS).flatMap((s) => {
            const p = s.placePrediction
            if (!p) return []
            return [
              {
                main: p.mainText?.toString() ?? p.text.toString(),
                secondary: p.secondaryText?.toString() ?? '',
                resolve: async () => {
                  const place = p.toPlace()
                  await place.fetchFields({
                    fields: ['addressComponents', 'location', 'formattedAddress'],
                  })
                  // A pick ends the billing session; the next keystroke starts a
                  // new one.
                  session.current = null
                  return componentsToAddress(
                    place.addressComponents ?? [],
                    place.location ?? null,
                    place.formattedAddress ?? '',
                  )
                },
              },
            ]
          }),
        )
        setOpen(true)
      } catch {
        // Offline, quota, a rejected key — all the same from here. Stop asking
        // and let the rep type, which is the behaviour this screen had before
        // suggestions existed.
        if (mine === seq.current) {
          setUnavailable(true)
          setSuggestions([])
          setOpen(false)
        }
      }
    },
    [near],
  )

  useEffect(() => {
    if (unavailable) return
    if (timer.current) window.clearTimeout(timer.current)
    const q = value.trim()
    if (q.length < MIN_CHARS) {
      setSuggestions([])
      setOpen(false)
      return
    }
    timer.current = window.setTimeout(() => void loadGmaps().then(() => search(q)).catch(() => setUnavailable(true)), DEBOUNCE)
    return () => {
      if (timer.current) window.clearTimeout(timer.current)
    }
  }, [value, search, unavailable])

  const choose = async (s: Suggestion) => {
    setResolving(true)
    setOpen(false)
    try {
      const picked = await s.resolve()
      if (picked) {
        onChange(picked.address1)
        onPick(picked)
      } else {
        // Resolved to something without a street. Keep what the rep typed rather
        // than replacing it with a city name.
        onChange(s.main)
      }
    } catch {
      onChange(s.main)
    } finally {
      setResolving(false)
    }
  }

  return (
    <div className="relative">
      <Field
        label={label}
        hint={hint}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Escape') setOpen(false)
        }}
        autoFocus={autoFocus}
        autoComplete="street-address"
        enterKeyHint="next"
        placeholder="123 Main Street"
        role="combobox"
        aria-expanded={open}
        aria-autocomplete="list"
        aria-controls="address-suggestions"
      />

      {resolving && (
        <p className="mt-1.5 text-[12.5px] text-ink-mute" role="status">
          Looking up that address…
        </p>
      )}

      {open && suggestions.length > 0 && (
        <>
          {/*
            Tapping anywhere else dismisses the list. A phone has no blur to rely
            on when the next tap is a suggestion.
          */}
          <button
            aria-hidden
            tabIndex={-1}
            onClick={() => setOpen(false)}
            className="fixed inset-0 z-10 cursor-default"
          />
          <ul
            id="address-suggestions"
            role="listbox"
            aria-label="Address suggestions"
            className="absolute inset-x-0 z-20 mt-1 overflow-hidden rounded-card bg-surface shadow-float ring-1 ring-line"
          >
            {suggestions.map((s, i) => (
              <li key={`${s.main}-${i}`} role="option" aria-selected={false}>
                <button
                  onClick={() => void choose(s)}
                  className="flex min-h-tap w-full flex-col items-start justify-center gap-0.5 border-b border-line-soft px-3.5 py-2.5 text-left last:border-0 active:bg-surface-field"
                >
                  <span className="text-[15px] font-semibold leading-tight">{s.main}</span>
                  {s.secondary && (
                    <span className="text-[12.5px] leading-tight text-ink-mute">{s.secondary}</span>
                  )}
                </button>
              </li>
            ))}
          </ul>
        </>
      )}
    </div>
  )
}
