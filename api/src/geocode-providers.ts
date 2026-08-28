/**
 * The geocoding providers a company may bring their own key for.
 *
 * A registry rather than a switch statement, because the question this answers
 * is a commercial one and it changes without the code changing: which vendors
 * a roofing company might already have an account with, what each costs, and —
 * the part that actually decides it — whether the vendor's terms let us keep
 * the coordinates they return.
 *
 * That last column is not a footnote. This app writes a lead's coordinates to
 * D1 and to every phone and keeps them for the life of the record, because the
 * map has to draw with no signal. A provider that only permits temporary
 * caching is in direct conflict with that, and a company choosing one is
 * choosing to carry that conflict under their own contract. So the terms are
 * carried here, next to the provider, and shown on the screen where the choice
 * is made — not buried in documentation nobody reads before pasting a key.
 *
 * `adapter` is the honest bit. `live` means there is code in this repo that
 * calls the provider and parses its answer. `planned` means the registry knows
 * about it and the UI can show it, but nothing can call it yet — and the API
 * refuses to save a key for it rather than accepting one that will silently
 * never work. Adding an adapter is a small, isolated change; pretending one
 * exists is not something this codebase does.
 */

export type StoragePosture =
  /** Coordinates may be kept for the life of the record. */
  | 'permanent'
  /** Permanent storage only under a specific plan or product tier. */
  | 'conditional'
  /** Temporary caching only — roughly thirty days, then deletion. */
  | 'temporary'

export interface GeocodeProvider {
  id: string
  label: string
  /** False only for Census, which needs no account at all. */
  needsKey: boolean
  /** Whether this repo can actually call it today. */
  adapter: 'live' | 'planned'
  storage: StoragePosture
  /** One line, written for the person pasting the key — not for a developer. */
  storageNote: string
  /** Rough list price, for orientation only. Verify before spending money. */
  price: string
  /** What the vendor gives away, if anything. */
  free: string
  /** How good the US pins are, in the terms this app cares about. */
  accuracy: string
  /** Where the company goes to get a key. */
  signup: string
}

/**
 * Ten providers, in the order they are offered.
 *
 * Census is first and is the default because it is the only one that works with
 * no account, no card and no decision — a company signing up on a Tuesday
 * afternoon gets working pins without talking to a vendor. Everything after it
 * is an upgrade someone has chosen to pay for.
 *
 * Prices and terms were gathered in August 2026 and every vendor host is
 * unreachable from the build container, so none of it could be checked against
 * the source. Treat it as orientation, not as a quote.
 */
export const GEOCODE_PROVIDERS: GeocodeProvider[] = [
  {
    id: 'census',
    label: 'US Census',
    needsKey: false,
    adapter: 'live',
    storage: 'permanent',
    storageNote: 'Public domain. Keep the coordinates as long as you like.',
    price: 'Free',
    free: 'Unlimited',
    accuracy: 'Right block and side of the street. Not the right house.',
    signup: '',
  },
  {
    id: 'geocodio',
    label: 'Geocodio',
    needsKey: true,
    adapter: 'planned',
    storage: 'permanent',
    storageNote: 'Permanent storage permitted.',
    price: '$1.00 per 1,000',
    free: '2,500 per day',
    accuracy: 'Rooftop for most US addresses; falls back to block level.',
    signup: 'https://www.geocod.io',
  },
  {
    id: 'google',
    label: 'Google',
    needsKey: true,
    adapter: 'live',
    storage: 'temporary',
    storageNote:
      'Google permits caching coordinates for about 30 days only. This app stores them permanently so the map works offline — using this key means accepting that conflict on your own account.',
    price: '$5.00 per 1,000',
    free: '10,000 per month',
    accuracy: 'The benchmark. Rooftop almost everywhere.',
    signup: 'https://console.cloud.google.com',
  },
  {
    id: 'locationiq',
    label: 'LocationIQ',
    needsKey: true,
    adapter: 'planned',
    storage: 'permanent',
    storageNote: 'Permanent storage permitted.',
    price: '~$0.33 per 1,000',
    free: '5,000 per day',
    accuracy: 'Built on OpenStreetMap — rooftop quality varies by area.',
    signup: 'https://locationiq.com',
  },
  {
    id: 'here',
    label: 'HERE',
    needsKey: true,
    adapter: 'planned',
    storage: 'permanent',
    storageNote: 'Permanent storage permitted.',
    price: 'Volume pricing',
    free: '250,000 per month',
    accuracy: 'Strong US coverage; built for logistics.',
    signup: 'https://developer.here.com',
  },
  {
    id: 'mapbox',
    label: 'Mapbox',
    needsKey: true,
    adapter: 'planned',
    storage: 'conditional',
    storageNote:
      'Standard geocoding may not be stored. Keeping coordinates requires their separate Permanent Geocoding product, which costs more.',
    price: '$0.75 per 1,000',
    free: '100,000 per month',
    accuracy: 'Good US coverage.',
    signup: 'https://account.mapbox.com',
  },
  {
    id: 'smarty',
    label: 'Smarty',
    needsKey: true,
    adapter: 'planned',
    storage: 'conditional',
    storageNote:
      'Most results may be kept permanently. US Rooftop results may only be kept while the rooftop subscription is active.',
    price: '$1.50–$3.00 per 1,000',
    free: 'Trial only',
    accuracy: 'US address specialist. Rooftop on the paid tier.',
    signup: 'https://www.smarty.com',
  },
  {
    id: 'tomtom',
    label: 'TomTom',
    needsKey: true,
    adapter: 'planned',
    storage: 'permanent',
    storageNote: 'Permanent storage permitted.',
    price: 'Volume pricing',
    free: 'Daily allowance',
    accuracy: 'Good US coverage.',
    signup: 'https://developer.tomtom.com',
  },
  {
    id: 'esri',
    label: 'Esri ArcGIS',
    needsKey: true,
    adapter: 'planned',
    storage: 'conditional',
    storageNote: 'Coordinates may only be stored on a paid plan.',
    price: '~$4.00 per 1,000',
    free: 'None for stored results',
    accuracy: 'Strong US coverage.',
    signup: 'https://developers.arcgis.com',
  },
  {
    id: 'radar',
    label: 'Radar',
    needsKey: true,
    adapter: 'planned',
    storage: 'temporary',
    storageNote:
      'Radar permits caching for about 30 days only — the same conflict as Google, at a lower price.',
    price: '~$0.50 per 1,000',
    free: 'Generous monthly tier',
    accuracy: 'Close to Google.',
    signup: 'https://radar.com',
  },
]

const BY_ID = new Map(GEOCODE_PROVIDERS.map((p) => [p.id, p]))

export function findProvider(id: string): GeocodeProvider | undefined {
  return BY_ID.get(id)
}

/**
 * Can a company select this today?
 *
 * Census needs no key, so it is always selectable. Everything else needs both a
 * working adapter and a key — and the check exists so the API can refuse a
 * choice that would quietly geocode nothing rather than accepting it and
 * failing at import time, in front of a customer, with 500 rows on screen.
 */
export function isSelectable(id: string): boolean {
  const p = BY_ID.get(id)
  return !!p && p.adapter === 'live'
}
