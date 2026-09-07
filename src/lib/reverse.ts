import { gmapsConfigured, loadGmaps } from './gmaps'
import type { PickedAddress } from '../components/property/AddressAutocomplete'

/**
 * What house is at this coordinate.
 *
 * The other direction from `AddressAutocomplete`: there the rep knows the
 * address and Google supplies the pin, here the rep points at a roof and Google
 * supplies the address. Same destination — a `PickedAddress` with real city,
 * state and ZIP — so the two paths write identical leads and nothing downstream
 * has to know which one a rep used.
 *
 * **It is allowed to fail, and failing is not an error.** A tap on a roof is
 * already a usable lead: the coordinate is exactly where the rep pointed, which
 * is the part they cannot type in. So every failure here — no signal, the
 * Geocoding API not enabled on the key, a coordinate in the middle of a field —
 * resolves to `null` and the caller falls back to an empty address field the rep
 * fills in themselves. The alternative is refusing to drop a pin because a
 * lookup did not answer, on the one screen that has to work at zero bars.
 *
 * `null` rather than a guess, for the same reason `NewLead` saves a blank city
 * rather than inventing one: blank is something the office can see and fix.
 *
 * ## The key needs the Geocoding API
 *
 * This is the one call in the app that uses it — autocomplete is Places, the
 * basemap is Maps JavaScript. A browser key restricted to the three APIs this
 * app needed before will answer `REQUEST_DENIED` here, and the symptom is a pin
 * that always drops with a blank address rather than anything that looks like a
 * misconfiguration. Enable **Geocoding API** on the same key and keep the
 * referrer restrictions as they are.
 */
export async function addressAt(
  lat: number,
  lng: number,
): Promise<PickedAddress | null> {
  if (!gmapsConfigured()) return null

  try {
    await loadGmaps()
    const { Geocoder } = (await google.maps.importLibrary(
      'geocoding',
    )) as google.maps.GeocodingLibrary

    const res = await new Geocoder().geocode({ location: { lat, lng } })
    const hit = pickRooftop(res.results)
    if (!hit) return null

    const parts = hit.address_components
    const find = (...types: string[]) =>
      parts.find((c) => types.some((t) => c.types.includes(t)))

    const number = find('street_number')?.long_name ?? ''
    const street = find('route')?.long_name ?? ''
    const address1 = [number, street].filter(Boolean).join(' ')
    // No street number and no street is a neighbourhood, not a door. The rep
    // gets an empty field to type into rather than a lead called "Hyde Park".
    if (!address1) return null

    return {
      address1,
      city:
        find('locality', 'postal_town', 'sublocality_level_1', 'sublocality')
          ?.long_name ?? '',
      // "TX", not "Texas" — what the rest of the app stores.
      state: find('administrative_area_level_1')?.short_name ?? '',
      zip: find('postal_code')?.long_name ?? '',
      /*
        The tapped point, not the one Google returns.

        Google answers with the geocoder's idea of the address's location, which
        for a rooftop result is the rooftop and for anything coarser is a street
        centreline or a block centroid. The rep pointed at a specific roof, and
        moving their pin to the middle of the street because the lookup was
        approximate would silently undo the thing they just did by hand.
      */
      lat,
      lng,
      formatted: hit.formatted_address,
    }
  } catch {
    // Deliberately swallowed — see the note above. The pin still drops.
    return null
  }
}

/**
 * Google returns results coarse-to-fine and expects the caller to choose.
 *
 * A tap between two houses can come back with the street, the block and the
 * neighbourhood ahead of any address, so taking `results[0]` gives a lead called
 * "W 41st St". Walk the precision order instead and only fall back to the first
 * result if nothing better exists.
 */
function pickRooftop(
  results: google.maps.GeocoderResult[],
): google.maps.GeocoderResult | undefined {
  const byType = (t: string) => results.find((r) => r.types.includes(t))
  return (
    byType('premise') ??
    byType('street_address') ??
    byType('subpremise') ??
    results[0]
  )
}
