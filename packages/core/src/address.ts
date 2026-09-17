/**
 * Turning Google's address components into the four fields this app stores.
 *
 * Google never returns "the street" or "the city". It returns a list of typed
 * components, and which type carries the city depends on how the place is
 * administered — a `locality` in most of the United States, a `postal_town` in
 * much of the United Kingdom, a `sublocality` in parts of New York. So this
 * walks a preference order rather than reading one key.
 *
 * It lives here, alone, because the app now asks Google for an address in two
 * different ways and gets two different shapes back:
 *
 *   The **Places** API (address autocomplete) returns `AddressComponent` with
 *   `longText` / `shortText`.
 *
 *   The **Geocoding** API (the address under a tapped pin) returns
 *   `GeocoderAddressComponent` with `long_name` / `short_name`.
 *
 * Same information, different spelling — which is exactly the shape of problem
 * that ends with two preference orders that agree on the day they were written
 * and disagree a year later. Each caller normalises into `AddressPart` and the
 * order is written once.
 */

/** One component, in this app's spelling rather than either of Google's. */
export interface AddressPart {
  types: string[]
  long: string
  short: string
}

export interface AddressFields {
  address1: string
  city: string
  state: string
  zip: string
}

/**
 * How exactly Google located the point it is describing.
 *
 * Google's own vocabulary, narrowed to the three values this app already stores
 * on a property. `GEOMETRIC_CENTER` and `APPROXIMATE` both collapse to
 * `approximate`: the distinction between "the centre of a road" and "the centre
 * of a postcode" is real to a cartographer and not to a rep standing on a
 * driveway — both mean the street number is a guess.
 */
export type AddressPrecision = 'rooftop' | 'interpolated' | 'approximate'

export function precisionOf(locationType: string | undefined): AddressPrecision {
  if (locationType === 'ROOFTOP') return 'rooftop'
  if (locationType === 'RANGE_INTERPOLATED') return 'interpolated'
  return 'approximate'
}

/** From the Places API's shape. */
export const fromPlaces = (
  parts: { types: string[]; longText?: string | null; shortText?: string | null }[],
): AddressPart[] =>
  parts.map((c) => ({ types: c.types, long: c.longText ?? '', short: c.shortText ?? '' }))

/** From the Geocoding API's shape. */
export const fromGeocoder = (
  parts: { types: string[]; long_name?: string; short_name?: string }[],
): AddressPart[] =>
  parts.map((c) => ({ types: c.types, long: c.long_name ?? '', short: c.short_name ?? '' }))

/**
 * The four fields, or nothing.
 *
 * Returns `null` when there is no street — a component list describing a city
 * or a county is a real answer to some question and not to this one, and saving
 * a lead whose address is "Austin" is worse than saving one with a blank
 * address the office can see and fix.
 */
export function partsToAddress(parts: AddressPart[]): AddressFields | null {
  const fields = partsToFields(parts)
  return fields.address1 ? fields : null
}

/**
 * The same four fields without insisting on a street.
 *
 * For a coarse result, where the town is genuinely known and the house number
 * is not. The town is not invented: it is whichever town contains the point the
 * rep actually tapped, which is a different thing from the hardcoded
 * "Round Rock, TX 78664" this app used to stamp on every field-added lead.
 */
export function partsToFields(parts: AddressPart[]): AddressFields {
  const find = (...types: string[]) => parts.find((c) => types.some((t) => c.types.includes(t)))

  const number = find('street_number')?.long ?? ''
  const street = find('route')?.long ?? ''
  const city = find('locality', 'postal_town', 'sublocality_level_1', 'sublocality')?.long ?? ''
  // Short: "TX" rather than "Texas", matching what the rest of the app stores.
  const state = find('administrative_area_level_1')?.short ?? ''
  const zip = find('postal_code')?.long ?? ''

  return { address1: [number, street].filter(Boolean).join(' '), city, state, zip }
}

/**
 * Is the address something to confirm, or something to type?
 *
 * A rep who tapped a house has already answered "which house" — with their
 * finger, on a map, while looking at it. Handing them an editable text box
 * pre-filled with a street address asks the question a second time, and the
 * two fields that actually still need them (who lives here, and their number)
 * sit underneath it looking like the same kind of question. So when the lookup
 * came back, the address stops being a field and becomes a line of text, and
 * the form is the two things left to fill in.
 *
 * `confirmed` is deliberately narrow. It needs all four:
 *
 *   `at`      — the address came from a tap. On the standalone Add-lead screen
 *               there is no pin to look up, so there is nothing to confirm.
 *   `filled`  — the lookup wrote the field. Once the rep has typed here the
 *               text is theirs, and collapsing it would hide their own work
 *               behind a "Change" button.
 *   `address1`— a street. A coarse answer gives a town and no number, which is
 *               not an address anybody can knock on.
 *   `!editing`— they have not asked to correct it.
 *
 * That last one is why this collapses rather than disappears. Reverse geocoding
 * names the nearest roof it knows, which on a corner lot or a long driveway is
 * the neighbour's — and the rep is standing at the door reading the number off
 * it. A form that shows an address it guessed and offers no way to fix it saves
 * the wrong house, quietly, and the office finds out later.
 *
 * Lives here rather than beside the form it belongs to because the form is a
 * `.tsx`, and Node can strip types but not JSX — so a decision that only ever
 * needed four booleans checked would have been unreachable from a gate that
 * runs without a browser. It matters here more than usual: the environment the
 * browser gates run in has no Google key, so the only branch they can reach is
 * the one where nothing came back.
 */
export function addressFieldMode(o: {
  at: { lat: number; lng: number } | null
  /*
    Typed against `AddressFields` rather than `ReverseAddress`, which extends
    it. `reverseGeocode.ts` imports this module, so naming its type here would
    be a cycle — and this function reads nothing but `address1` anyway.
  */
  found: AddressFields | null
  filled: boolean
  editing: boolean
}): 'confirmed' | 'input' {
  return o.at && o.filled && !o.editing && !!o.found?.address1 ? 'confirmed' : 'input'
}
