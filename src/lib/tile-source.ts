import { useEffect, useState } from 'react'
import * as db from './db'
import type { TileRef } from './tiles'

/**
 * Stored tiles, resolved for display.
 *
 * The map draws each tile as an `<image href>`, which is an ordinary network
 * request. Downloaded imagery used to be served back to those requests by the
 * service worker and by nothing else — so the feature quietly depended on a
 * worker existing, and in the packaged app none does: Expo hands the DOM
 * component to the webview from a `file://` URL, where no service worker runs
 * on either platform. A rep could tap download, watch it succeed, and still
 * find a blank map in a dead zone.
 *
 * So the lookup happens here instead, in app code, against the same IndexedDB
 * store the download writes to. One path, and it works wherever IndexedDB does,
 * which is everywhere this app runs.
 *
 * A tile that is not stored falls through to its network URL unchanged. Online
 * with nothing downloaded, that is every tile, and the map behaves exactly as it
 * did before.
 */

/**
 * How many decoded tiles to hold object URLs for.
 *
 * Each one pins its blob in memory until revoked, so this is a real memory
 * ceiling rather than a tidiness rule. A 430pt phone shows about 20 tiles and
 * the map renders a ring beyond each edge; 192 is roughly six screens' worth,
 * enough that a pan back to where a rep just was is instant and small enough
 * that a morning of panning cannot accumulate a territory in RAM.
 */
const MAX_OBJECT_URLS = 192

/** url -> object URL, in insertion order, which is the eviction order. */
const resolved = new Map<string, string>()
/**
 * Tiles known not to be stored.
 *
 * Without this every pan re-reads IndexedDB for imagery that was absent a
 * moment ago — one lookup per visible tile per frame, all of them misses. It is
 * cleared by `resetTileSource()` rather than expiring, because the only thing
 * that turns a miss into a hit is a download, and the download says so.
 */
const missing = new Set<string>()
const inflight = new Set<string>()

function remember(url: string, objectUrl: string): void {
  resolved.set(url, objectUrl)
  while (resolved.size > MAX_OBJECT_URLS) {
    const oldest = resolved.keys().next().value
    if (oldest === undefined) break
    const stale = resolved.get(oldest)
    resolved.delete(oldest)
    // Revoked on eviction, not on unmount: the same tile is very likely to come
    // back on the next pan, and a revoked URL renders as a broken image.
    if (stale) URL.revokeObjectURL(stale)
  }
}

/**
 * Forget what is stored and what is not.
 *
 * Called after a download and after a delete — both change the answer for every
 * tile at once, and neither is frequent enough to be worth a finer-grained
 * invalidation.
 */
export function resetTileSource(): void {
  for (const objectUrl of resolved.values()) URL.revokeObjectURL(objectUrl)
  resolved.clear()
  missing.clear()
}

/**
 * Resolve the tiles currently on screen, and return a lookup for rendering.
 *
 * The returned function is called during render for every visible tile, so it
 * is a plain map read — the asynchronous part happens in the effect and asks
 * for a re-render only when something was actually found.
 */
export function useStoredTiles(tiles: TileRef[]): (url: string) => string {
  const [, bump] = useState(0)

  useEffect(() => {
    const wanted = tiles
      .map((t) => t.url)
      .filter((u) => !resolved.has(u) && !missing.has(u) && !inflight.has(u))
    if (wanted.length === 0) return

    let live = true
    wanted.forEach((u) => inflight.add(u))
    void (async () => {
      let found = false
      for (const url of wanted) {
        try {
          const blob = await db.tileGet(url)
          if (blob) {
            remember(url, URL.createObjectURL(blob))
            found = true
          } else {
            missing.add(url)
          }
        } catch {
          // No IndexedDB, or a read that failed. Either way this tile comes off
          // the network, which is the behaviour with no download at all.
          missing.add(url)
        }
        inflight.delete(url)
      }
      if (live && found) bump((n) => n + 1)
    })()

    return () => {
      live = false
    }
  }, [tiles])

  return (url: string) => resolved.get(url) ?? url
}
