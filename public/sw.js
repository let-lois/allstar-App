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
const VERSION = 'v2'
const CACHE = `allstar-shell-${VERSION}`
const SHELL = ['/', '/index.html', '/manifest.webmanifest', '/icon.svg']

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
      await Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k)))
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
     * A misdirected response can also be sitting in the browser's own HTTP
     * cache, where `immutable` means it is reused for the whole of max-age
     * without ever revalidating — so simply fetching again returns the same
     * wrong bytes. One forced trip past that cache is enough to heal it, and
     * costs a single request on the one load where it is needed.
     */
    if (isMisdirected(url, res)) {
      res = await fetch(req.url, { cache: 'reload', credentials: 'same-origin' })
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
