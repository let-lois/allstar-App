import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Button } from '../ui/Button'
import { ProgressBar } from '../ui/ProgressBar'
import { Collapsible } from '../ui/Collapsible'
import { useScopedProperties } from '../../store/useAppStore'
import {
  boundsOf,
  cachedCount,
  clearTileCache,
  estimateBytes,
  loadLayer,
  prefetchTiles,
  tilesAvailable,
  tilesForBounds,
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
 */
export function OfflineMaps() {
  const properties = useScopedProperties()
  const [layer] = useState<LayerId>(() => loadLayer())
  const [progress, setProgress] = useState<PrefetchProgress | null>(null)
  const [already, setAlready] = useState<number | null>(null)
  const [busy, setBusy] = useState(false)
  const [note, setNote] = useState<string | null>(null)
  const abort = useRef<AbortController | null>(null)

  const urls = useMemo(() => {
    const bounds = boundsOf(properties.map((p) => ({ lat: p.lat, lng: p.lng })))
    return bounds ? tilesForBounds(bounds, layer) : []
  }, [properties, layer])

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

  // Nothing to say without a tile key — the map draws its own basemap and works
  // offline already, so an "offline maps" control would only confuse.
  if (!tilesAvailable()) return null

  const megabytes = (estimateBytes(urls.length, layer) / 1_000_000).toFixed(0)
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
      if (controller.signal.aborted) {
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
    }
  }

  return (
    <Collapsible
      title="Offline maps"
      right={
        <span className="nums text-xs text-ink-mute">
          {complete ? 'Saved' : `${remainingMb} MB`}
        </span>
      }
    >
      {urls.length === 0 ? (
        <p className="text-[14px] text-ink-mute">
          Nothing is assigned to you yet, so there is no area to download.
        </p>
      ) : (
        <>
          <p className="text-[13px] leading-relaxed text-ink-mute">
            Saves the {layer === 'satellite' ? 'satellite imagery' : 'street map'} for your
            assigned area so it still draws with no signal. Do this on wi-fi before you head
            out — it downloads about {megabytes} MB.
          </p>

          <dl className="mt-3 grid grid-cols-2 gap-y-2 text-[14px]">
            <dt className="text-ink-mute">Map tiles</dt>
            <dd className="nums text-right font-semibold">{urls.length.toLocaleString()}</dd>
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
                  setNote(null)
                  refreshCached()
                }}
              >
                Clear
              </Button>
            )}
          </div>
        </>
      )}
    </Collapsible>
  )
}
