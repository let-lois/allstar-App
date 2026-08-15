const EARTH_RADIUS_MI = 3958.8

const toRad = (deg: number) => (deg * Math.PI) / 180

/** Great-circle distance in miles. */
export function distanceMiles(
  a: { lat: number; lng: number },
  b: { lat: number; lng: number },
): number {
  const dLat = toRad(b.lat - a.lat)
  const dLng = toRad(b.lng - a.lng)
  const lat1 = toRad(a.lat)
  const lat2 = toRad(b.lat)
  const h =
    Math.sin(dLat / 2) ** 2 + Math.sin(dLng / 2) ** 2 * Math.cos(lat1) * Math.cos(lat2)
  return 2 * EARTH_RADIUS_MI * Math.asin(Math.min(1, Math.sqrt(h)))
}

/**
 * Distance phrased the way a rep reads it while walking: feet up close, then
 * tenths of a mile. Never "0.03 mi".
 */
export function formatDistance(miles: number): string {
  if (!Number.isFinite(miles)) return '—'
  const feet = miles * 5280
  if (feet < 1000) return `${Math.round(feet / 10) * 10} ft`
  if (miles < 10) return `${miles.toFixed(1)} mi`
  return `${Math.round(miles)} mi`
}

/** Rough walking ETA — reps move door to door, not at driving speed. */
export function walkMinutes(miles: number): number {
  return Math.max(1, Math.round((miles / 3.1) * 60))
}

export function bearing(
  a: { lat: number; lng: number },
  b: { lat: number; lng: number },
): number {
  const y = Math.sin(toRad(b.lng - a.lng)) * Math.cos(toRad(b.lat))
  const x =
    Math.cos(toRad(a.lat)) * Math.sin(toRad(b.lat)) -
    Math.sin(toRad(a.lat)) * Math.cos(toRad(b.lat)) * Math.cos(toRad(b.lng - a.lng))
  return (Math.atan2(y, x) * 180) / Math.PI
}

export function compassLabel(deg: number): string {
  const dirs = ['N', 'NE', 'E', 'SE', 'S', 'SW', 'W', 'NW']
  return dirs[Math.round((((deg % 360) + 360) % 360) / 45) % 8]
}

/* --- Web Mercator, used by the in-app map renderer ----------------------- */

export function project(lat: number, lng: number) {
  const x = (lng + 180) / 360
  const s = Math.sin(toRad(lat))
  const y = 0.5 - Math.log((1 + s) / (1 - s)) / (4 * Math.PI)
  return { x, y }
}

export function unproject(x: number, y: number) {
  const lng = x * 360 - 180
  const n = Math.PI * (1 - 2 * y)
  const lat = (180 / Math.PI) * Math.atan(0.5 * (Math.exp(n) - Math.exp(-n)))
  return { lat, lng }
}

/**
 * Hands the address off to whatever the device actually uses for turn-by-turn.
 * Apple Maps on iOS, Google Maps elsewhere — reps should not have to copy/paste.
 */
export function navigationUrl(dest: { lat: number; lng: number; label?: string }): string {
  const isApple = /iPhone|iPad|iPod|Macintosh/.test(navigator.userAgent)
  const q = `${dest.lat},${dest.lng}`
  if (isApple) {
    return `https://maps.apple.com/?daddr=${encodeURIComponent(q)}&dirflg=d`
  }
  return `https://www.google.com/maps/dir/?api=1&destination=${encodeURIComponent(q)}&travelmode=driving`
}

export interface Position {
  lat: number
  lng: number
  accuracy: number
  at: number
}

/**
 * One-shot fix with a hard timeout. A rep standing between houses should never
 * be blocked on GPS — callers treat `null` as "we don't know yet" and carry on.
 */
export function getPosition(timeoutMs = 8000): Promise<Position | null> {
  if (!('geolocation' in navigator)) return Promise.resolve(null)
  return new Promise((resolve) => {
    let settled = false
    const done = (p: Position | null) => {
      if (settled) return
      settled = true
      resolve(p)
    }
    const timer = setTimeout(() => done(null), timeoutMs)
    navigator.geolocation.getCurrentPosition(
      (pos) => {
        clearTimeout(timer)
        done({
          lat: pos.coords.latitude,
          lng: pos.coords.longitude,
          accuracy: pos.coords.accuracy,
          at: pos.timestamp,
        })
      },
      () => {
        clearTimeout(timer)
        done(null)
      },
      { enableHighAccuracy: true, timeout: timeoutMs, maximumAge: 15000 },
    )
  })
}

export function watchPosition(cb: (p: Position) => void): () => void {
  if (!('geolocation' in navigator)) return () => {}
  const id = navigator.geolocation.watchPosition(
    (pos) =>
      cb({
        lat: pos.coords.latitude,
        lng: pos.coords.longitude,
        accuracy: pos.coords.accuracy,
        at: pos.timestamp,
      }),
    () => {},
    { enableHighAccuracy: true, maximumAge: 10000, timeout: 20000 },
  )
  return () => navigator.geolocation.clearWatch(id)
}
