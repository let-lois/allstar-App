/**
 * App-shell service worker.
 *
 * Its only job is making a cold start work with no connection: cache the built
 * assets, serve the SPA shell for navigations. Business data is *not* cached
 * here — that lives in IndexedDB, where the app can reason about it. Mixing the
 * two produces stale reads that are very hard to debug in the field.
 *
 * Two rules govern everything below, both learned the hard way.
 *
 * A worker that throws is worse than no worker at all. `respondWith()` turns a
 * rejected promise into a network error for that request, and the page has no
 * way to retry — a stylesheet dies silently and the app renders unstyled with
 * nothing in the console except a rejection from this file. Every branch here
 * ends in a real Response.
 *
 * And a 200 is not proof of a correct response. Cloudflare's SPA fallback
 * answers a missing /assets/* file with index.html and a 200; caching that
 * pins an HTML document under a .js or .css URL until this cache is deleted.
 */

/*
 * Bump VERSION to abandon every previously cached response.
 *
 * This was hardcoded to a single name from the day it shipped, which meant the
 * eviction pass in `activate` — delete every key that is not the current one —
 * had never once had anything to delete. A poisoned entry was therefore
 * permanent, and unreachable from a rep's phone.
 */
const VERSION = 'v5'
const CACHE = `allstar-shell-${VERSION}`
const SHELL = ['/', '/index.html', '/manifest.webmanifest', '/favicon-32.png']

/*
 * Basemap tiles, kept apart from the app shell.
 *
 * Separate cache because the two have opposite lifecycles: the shell is replaced
 * wholesale on every deploy, while tiles for a rep's territory stay valid for
 * months and are expensive to re-fetch on a metered connection. Bumping the
 * shell version must not throw away a morning's downloaded imagery.
 *
 * Tiles arrive as opaque cross-origin responses, so their status is not readable
 * — that is expected and they are stored anyway, which is the one place this
 * worker cannot verify what it is caching.
 */
const TILE_HOST = 'api.maptiler.com'
const TILE_CACHE = 'allstar-tiles-v1'
/*
 * Cap chosen against what a real territory costs, not picked round.
 *
 * A 3.6 km territory prefetched across z14-18 is ~1,160 tiles. At the old cap of
 * 1,500 a single download all but filled the cache, and the oldest-first trim
 * below would then start evicting the tiles the rep had just downloaded the
 * moment they panned anywhere else — the exact opposite of what a deliberate
 * offline download is for. 4,000 leaves room for a territory plus normal
 * wandering, and is around 100 MB worst case for satellite, which is opt-in and
 * clearable from the More screen.
 */
const TILE_LIMIT = 4000

self.addEventListener('install', (event) => {
  event.waitUntil(
    (async () => {
      const cache = await caches.open(CACHE)
      // One at a time, not addAll: addAll is atomic, so a single missing file
      // aborts the install and the worker never activates at all.
      await Promise.all(SHELL.map((path) => cache.add(path).catch(() => {})))
      await self.skipWaiting()
    })(),
  )
})

self.addEventListener('activate', (event) => {
  event.waitUntil(
    (async () => {
      const keys = await caches.keys()
      await Promise.all(
        keys
          .filter((k) => k !== CACHE && k !== TILE_CACHE)
          .map((k) => caches.delete(k)),
      )
      await self.clients.claim()
    })(),
  )
})

self.addEventListener('fetch', (event) => {
  const req = event.request
  if (req.method !== 'GET') return

  let url
  try {
    url = new URL(req.url)
  } catch {
    return
  }
  // Tiles are the one cross-origin thing worth handling: cache-first, because an
  // imagery tile for a given z/x/y never changes, and a rep who walked a street
  // yesterday should see it today with no signal.
  if (url.hostname === TILE_HOST) {
    event.respondWith(tile(req))
    return
  }

  if (url.origin !== self.location.origin) return

  if (req.mode === 'navigate') {
    event.respondWith(navigation(req))
    return
  }

  // Only the build output is ours. Anything else goes to the network untouched
  // rather than through a handler that could get it wrong.
  if (!isCacheable(url)) return

  event.respondWith(asset(req, url))
})

function isCacheable(url) {
  return url.pathname.startsWith('/assets/') || SHELL.includes(url.pathname)
}

/**
 * Is this response plainly not the thing that was asked for?
 *
 * An HTML body under /assets/ means the SPA fallback answered instead of the
 * file. It is a miss dressed as a hit: never store it, never serve it.
 */
function isMisdirected(url, res) {
  if (!url.pathname.startsWith('/assets/')) return false
  return (res.headers.get('content-type') || '').includes('text/html')
}

function storable(url, res) {
  return !!res && res.status === 200 && res.type !== 'opaque' && !isMisdirected(url, res)
}

async function navigation(req) {
  try {
    const res = await fetch(req)
    // Only an HTML 200 is the app shell. A 404 page, or a stylesheet fetched by
    // typing its URL into the address bar, must never be stored as /index.html —
    // that would pin a broken shell for every later offline start.
    if (res && res.status === 200 && (res.headers.get('content-type') || '').includes('text/html')) {
      const copy = res.clone()
      caches
        .open(CACHE)
        .then((c) => c.put('/index.html', copy))
        .catch(() => {})
    }
    return res
  } catch {
    // Offline, mid-visit, no signal. This is the case the worker exists for.
    const cached = await caches.match('/index.html')
    return cached || Response.error()
  }
}

async function asset(req, url) {
  const hit = await caches.match(req)
  // A previously poisoned entry is treated as absent rather than trusted, so a
  // bad response cached by an older version of this worker heals itself on the
  // next load instead of needing the rep to clear their browser.
  if (hit && !isMisdirected(url, hit)) return hit

  try {
    let res = await fetch(req)

    /*
     * Heal a misdirected response rather than pass it on.
     *
     * `cache: 'reload'` gets past the browser's own HTTP cache. It does not get
     * past Cloudflare's, which ignores a client's no-cache by design — so the
     * query string is what actually matters: the edge caches per full URL, so a
     * distinct one is a guaranteed miss and goes to the origin, while Pages
     * matches static files on path alone and ignores the query entirely. The
     * result is stored under the original request key, so this costs one extra
     * request once, not on every load.
     */
    if (isMisdirected(url, res)) {
      const bust = `${url.pathname}?sw=${VERSION}`
      res = await fetch(bust, { cache: 'reload', credentials: 'same-origin' })
    }

    if (storable(url, res)) {
      const copy = res.clone()
      caches
        .open(CACHE)
        .then((c) => c.put(req, copy))
        .catch(() => {})
    }
    return res
  } catch {
    // The branch that was missing. Without it this rejection reached
    // respondWith() and the browser reported the request as a network error —
    // which for a stylesheet means an unstyled app and no way to tell why.
    return hit || Response.error()
  }
}

async function tile(req) {
  const cache = await caches.open(TILE_CACHE)
  const hit = await cache.match(req)
  if (hit) return hit

  try {
    const res = await fetch(req)
    // An opaque response reports status 0, so `ok` is useless here. Store it —
    // a broken tile costs one blank square, and refusing to cache would mean
    // no offline imagery at all.
    if (res) {
      cache.put(req, res.clone()).then(() => trim(cache)).catch(() => {})
    }
    return res
  } catch {
    // No signal and not cached. Resolving empty rather than rejecting lets the
    // drawn basemap show through instead of the browser logging a failure for
    // every tile in the viewport.
    return new Response(null, { status: 504 })
  }
}

/**
 * Evict oldest-first once over the cap.
 *
 * Cache Storage has no eviction policy of its own, so without this a rep who
 * pans around for a month fills their device quota and the browser starts
 * dropping the app shell — the offline cold start goes with it. `keys()` returns
 * insertion order, which is a good enough proxy for least-recently-added.
 */
async function trim(cache) {
  const keys = await cache.keys()
  const excess = keys.length - TILE_LIMIT
  if (excess <= 0) return
  await Promise.all(keys.slice(0, excess).map((k) => cache.delete(k)))
}
