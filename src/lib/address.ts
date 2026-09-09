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
