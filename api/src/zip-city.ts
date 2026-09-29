import type { Bucket } from './addresses'

/**
 * The postal town for a ZIP, for a lead whose address source has none.
 *
 * Census street ranges give the street, the number, the ZIP and the state, but
 * not the town, so a lead estimated from them read "201 Roe Rd, SC 29611". The
 * town is what a rep and a homeowner say and what a quote is addressed to. The
 * table is GeoNames' US postal-code list (CC BY 4.0, credited in
 * docs/ADDRESS_SOURCES.md), loaded into the address bucket by
 * scripts/zip-cities-build.mjs as one small JSON object of ZIP to town.
 *
 * Read once per Worker instance and kept: it changes when somebody reloads it,
 * not between requests. Absent is not an error — leads simply keep a blank town,
 * as they did before — and an absent table is not remembered for long, so a
 * table loaded after deploy is picked up without one.
 */
export const ZIP_CITY_KEY = 'meta/zip-city.json'

let cached: { map: Record<string, string> | null; at: number } | null = null
const KEEP_MS = 6 * 3_600_000
const KEEP_ABSENT_MS = 5 * 60_000

export async function zipCities(bucket: Bucket | undefined): Promise<Record<string, string> | null> {
  if (!bucket) return null
  const now = Date.now()
  if (cached && now - cached.at < (cached.map ? KEEP_MS : KEEP_ABSENT_MS)) return cached.map
  try {
    const obj = await bucket.get(ZIP_CITY_KEY)
    const parsed: unknown = obj ? await obj.json() : null
    const map = parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? (parsed as Record<string, string>) : null
    cached = { map, at: now }
    return map
  } catch {
    cached = { map: null, at: now }
    return null
  }
}

/** Fill a blank town from the ZIP, when the table knows it. */
export function withTown<T extends { city?: string | null; zip?: string | null }>(a: T, map: Record<string, string> | null): T {
  if (!map || (a.city && a.city.trim())) return a
  const zip = (a.zip ?? '').trim().slice(0, 5)
  const town = zip ? map[zip] : undefined
  return town ? { ...a, city: town } : a
}
