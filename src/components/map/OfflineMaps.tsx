import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Button } from '../ui/Button'
import { ProgressBar } from '../ui/ProgressBar'
import { Collapsible } from '../ui/Collapsible'
import { useScopedProperties } from '../../store/useAppStore'
import { resetTileSource } from '../../lib/tile-source'
import {
  boundsOf,
  cachedCount,
  clearTileCache,
  estimateBytes,
  loadLayer,
  prefetchTiles,
  tileCountForBounds,
  tilesAvailable,
  tilesForBounds,
  zoomsWithinBudget,
  PREFETCH_ZOOMS,
  type Bounds,
  type LayerId,
  type PrefetchProgress,
} from '../../lib/tiles'

/**
 * Download the map for a rep's territory before they lose signal.
 *
 * Caching imagery as it is viewed only covers streets a rep has already looked
 * at, which is the wrong set: the ones that matter are the ones they have not
 * been to yet. This pulls the whole assigned area down in one deliberate action,
 * so the morning's download covers the day's work.
 *
 * The size is shown before anything is fetched, and the button names it. A rep
 * on a metered plan gets to decide, rather than discovering the cost afterwards.
 *
 * **Split in two, and that split is the point.** The outer component is
 * arithmetic — bounds, a tile count, an estimate — and runs on every visit to
 * More. The panel does the expensive work and only mounts when the section is
 * actually open, because `Collapsible` renders its children lazily.
 *
 * It used to be one component that built the full URL list on mount. For a rep
 * whose leads span eighty miles that is 1.39 million strings and a Set to match:
 * 2.8 seconds on a desktop, several times that on a phone, every single time the
 * More screen was opened — to render one number in a collapsed header. See
 * `tileCountForBounds`.
 */
export function OfflineMaps() {
  const properties = useScopedProperties()
  const [layer] = useState<LayerId>(() => loadLayer())

  const bounds = useMemo(
    () => boundsOf(properties.map((p) => ({ lat: p.lat, lng: p.lng }))),
    [properties],
  )

  /*
    Everything here is a multiplication. No URLs are built, nothing touches the
    cache, and none of it depends on how large the territory is — which is what
    makes opening More instant regardless of whether a rep covers two streets or
    two counties.
  */
  const zooms = useMemo(
    () => (bounds ? zoomsWithinBudget(bounds, layer) : []),
    [bounds, layer],
  )
  const tileCount = useMemo(
    () => (bounds ? tileCountForBounds(bounds, layer, zooms) : 0),
    [bounds, layer, zooms],
  )

  if (!tilesAvailable()) return null

  const megabytes = (estimateBytes(tileCount, layer) / 1_000_000).toFixed(0)
  const trimmed = zooms.length > 0 && zooms.length < PREFETCH_ZOOMS.length
  /*
    No zoom level fits the budget — the leads are spread so wide that even the
    shallowest one is gigabytes.

    This is a different state from "nothing is assigned", and telling them
    apart matters because they point at different things to do. A rep with an
    empty patch waits for their manager. A rep whose patch spans a state almost
    always has one lead in the wrong place — a row that geocoded to 0,0 is the
    usual culprit — and the fix is on the lead, not on this screen.

    Until this existed the budget could not say "none of it", so it said `[14]`
    and the panel offered a 2.6 GB download it then tried to enumerate. See
    `zoomsWithinBudget`.
  */
  const tooWide = !!bounds && zooms.length === 0

  return (
    <Collapsible
      title="Offline maps"
      right={
        <span className="nums text-xs text-ink-soft">{tooWide ? '—' : `${megabytes} MB`}</span>
      }
    >
      {tooWide ? (
        <p className="text-[14px] leading-relaxed text-ink-mute">
          Your leads are spread too far apart to save as one area — it would run to
          gigabytes. Usually that means one lead is in the wrong place; check the
          map for a pin a long way from the rest, fix its address, and try again.
        </p>
      ) : !bounds || tileCount === 0 ? (
        <p className="text-[14px] text-ink-mute">
          Nothing is assigned to you yet, so there is no area to download.
        </p>
      ) : (
        <OfflineMapsPanel
          bounds={bounds}
          layer={layer}
          zooms={zooms}
          tileCount={tileCount}
          megabytes={megabytes}
          trimmed={trimmed}
        />
      )}
    </Collapsible>
  )
}

/**
 * The expensive half, mounted only when the section is open.
 *
 * Building the URL list and reading the tile cache both cost time proportional
 * to the area, so they happen behind a deliberate tap rather than on the way
 * past. Within the zoom budget the list is bounded — about 44,000 tiles at the
 * 400 MB ceiling — so this is work a phone can do.
 */
function OfflineMapsPanel({
  bounds,
  layer,
  zooms,
  tileCount,
  megabytes,
  trimmed,
}: {
  bounds: Bounds
  layer: LayerId
  zooms: number[]
  tileCount: number
  megabytes: string
  trimmed: boolean
}) {
  const [progress, setProgress] = useState<PrefetchProgress | null>(null)
  const [already, setAlready] = useState<number | null>(null)
  const [busy, setBusy] = useState(false)
  const [note, setNote] = useState<string | null>(null)
  const abort = useRef<AbortController | null>(null)

  const urls = useMemo(() => tilesForBounds(bounds, layer, zooms), [bounds, layer, zooms])

  const refreshCached = useCallback(() => {
    if (urls.length === 0) {
      setAlready(0)
      return
    }
    void cachedCount(urls).then(setAlready)
  }, [urls])

  useEffect(() => {
    refreshCached()
  }, [refreshCached])

  const remaining = already == null ? urls.length : Math.max(0, urls.length - already)
  const remainingMb = (estimateBytes(remaining, layer) / 1_000_000).toFixed(0)
  const complete = already != null && urls.length > 0 && already >= urls.length

  const start = async () => {
    const controller = new AbortController()
    abort.current = controller
    setBusy(true)
    setNote(null)
    setProgress({ done: 0, total: urls.length, failed: 0 })
    try {
      const result = await prefetchTiles(urls, {
        onProgress: setProgress,
        signal: controller.signal,
      })
      if (result.unsupported) {
        /*
          A different failure from a bad connection, and it needs different
          words: no amount of retrying will help, because this platform has
          nowhere to put the imagery. Saying "try again on a better connection"
          would send a rep to stand by a window for nothing.
        */
        setNote('This app cannot store map imagery on this device.')
      } else if (controller.signal.aborted) {
        setNote('Stopped. What downloaded is saved.')
      } else if (result.failed > 0) {
        setNote(
          `Saved ${result.done.toLocaleString()} of ${result.total.toLocaleString()}. ` +
            `${result.failed.toLocaleString()} could not be downloaded — try again on a better connection.`,
        )
      } else {
        setNote('Your territory is saved. The map works with no signal.')
      }
    } finally {
      setBusy(false)
      abort.current = null
      refreshCached()
      // The map remembers which tiles were missing so a pan does not re-read
      // storage for imagery that was absent a moment ago. A download is the one
      // thing that turns those misses into hits, so it says so.
      resetTileSource()
    }
  }

  return (
    <>
      <p className="text-[13px] leading-relaxed text-ink-mute">
        Saves the {layer === 'satellite' ? 'satellite imagery' : 'street map'} for your
        assigned area so it still draws with no signal. Do this on wi-fi before you head
        out — it downloads about {megabytes} MB.
      </p>

      {/*
        Said plainly rather than silently dropped. The deepest zoom is about three
        quarters of any download, and for a wide territory it alone runs to
        gigabytes — so it comes off, and the rep is told what they are getting
        instead of discovering it at a door.
      */}
      {trimmed && (
        <p className="mt-2 text-[13px] leading-relaxed text-ink-mute">
          Your area is too large to save at full street detail, so this saves the
          wider view of it. Zoomed right in, the map falls back to its own drawn
          basemap — which works with no signal either.
        </p>
      )}

      <dl className="mt-3 grid grid-cols-2 gap-y-2 text-[14px]">
        <dt className="text-ink-mute">Map tiles</dt>
        <dd className="nums text-right font-semibold">{tileCount.toLocaleString()}</dd>
        <dt className="text-ink-mute">Already saved</dt>
        <dd className="nums text-right font-semibold">
          {already == null ? '…' : already.toLocaleString()}
        </dd>
      </dl>

      {busy && progress && (
        <div className="mt-4">
          <ProgressBar
            value={progress.done + progress.failed}
            max={Math.max(progress.total, 1)}
            animate={false}
            label={`Downloading ${progress.done} of ${progress.total}`}
          />
          <p className="nums mt-2 text-[13px] text-ink-mute">
            {(progress.done + progress.failed).toLocaleString()} of{' '}
            {progress.total.toLocaleString()}
            {progress.failed > 0 ? ` · ${progress.failed} failed` : ''}
          </p>
        </div>
      )}

      {note && (
        <p role="status" className="mt-3 text-[13px] font-medium text-ink-soft">
          {note}
        </p>
      )}

      <div className="mt-4 flex gap-2.5">
        {busy ? (
          <Button variant="secondary" full onClick={() => abort.current?.abort()}>
            Stop
          </Button>
        ) : (
          <Button full onClick={() => void start()} disabled={complete}>
            {complete ? 'Territory saved' : `Download ${remainingMb} MB`}
          </Button>
        )}
        {!busy && (already ?? 0) > 0 && (
          <Button
            variant="secondary"
            onClick={async () => {
              if (!window.confirm('Delete saved map imagery from this device?')) return
              await clearTileCache()
              resetTileSource()
              setNote(null)
              refreshCached()
            }}
          >
            Clear
          </Button>
        )}
      </div>
    </>
  )

}
