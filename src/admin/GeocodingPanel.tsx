import { useEffect, useState } from 'react'
import { Button } from '../components/ui/Button'
import { Field } from '../components/ui/Input'
import {
  apiGeocoders,
  apiRemoveGeocoderKey,
  apiSaveGeocoderKey,
  apiSetActiveGeocoder,
  type GeocodeProviderDTO,
  type GeocodersDTO,
} from '../lib/http'
import { liveToken } from '../lib/session'
import { useAppStore } from '../store/useAppStore'

/**
 * Where a company chooses who turns their addresses into map pins.
 *
 * The screen exists because the vendors disagree about something that matters
 * more than price: whether we may keep the coordinates they return. This app
 * stores them permanently, on the server and on every phone, because the map
 * has to draw with no signal. A provider that only allows temporary caching is
 * in conflict with that — so the terms are stated on the row, next to the
 * button that selects it, rather than left in documentation.
 *
 * Two things this deliberately does not do.
 *
 * It never shows a stored key. There is no endpoint that returns one; a saved
 * provider shows a masked hint derived by decrypting and re-masking on the
 * server, and changing a key means pasting a fresh one.
 *
 * And it never offers a provider it cannot actually call. A vendor with no
 * adapter in this deployment is listed — a company should be able to see what
 * is coming — but it is visibly unavailable and the API refuses a key for it.
 * Accepting one would produce the worst outcome on this screen: an operator who
 * has been told they are connected, and an import that quietly geocodes with
 * something else.
 */

const STORAGE_WORD: Record<GeocodeProviderDTO['storage'], string> = {
  permanent: 'Keeps coordinates',
  conditional: 'Conditional',
  temporary: '30 days only',
}

const STORAGE_TONE: Record<GeocodeProviderDTO['storage'], string> = {
  permanent: 'bg-ok-soft text-ok',
  conditional: 'bg-warn-soft text-warn',
  temporary: 'bg-bad-soft text-bad',
}

export function GeocodingPanel() {
  const mode = useAppStore((s) => s.mode)

  const [data, setData] = useState<GeocodersDTO | null>(null)
  const [loading, setLoading] = useState(true)
  const [openFor, setOpenFor] = useState<string | null>(null)
  const [key, setKey] = useState('')
  const [busy, setBusy] = useState(false)
  const [notice, setNotice] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)

  async function load() {
    const t = liveToken()
    if (!t) {
      setLoading(false)
      return
    }
    try {
      setData(await apiGeocoders(t))
    } catch {
      // The catalogue failing to load is not worth an alarm — the next load
      // will say, and nothing here is destructive in the meantime.
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => {
    void load()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  async function run(fn: (t: string) => Promise<GeocodersDTO>, ok: string) {
    const t = liveToken()
    if (!t) {
      setError('This needs a live account. The demo has no company to configure.')
      return
    }
    setBusy(true)
    setError(null)
    setNotice(null)
    try {
      setData(await fn(t))
      setNotice(ok)
      setOpenFor(null)
      setKey('')
    } catch (err) {
      setError(err instanceof Error ? err.message : 'That did not save.')
    } finally {
      setBusy(false)
    }
  }

  if (mode === 'demo') {
    return (
      <p className="p-4 text-[15px] text-ink-mute">
        The demo has no company account, so there is nothing to connect a geocoding
        provider to. Addresses in the demo are already placed.
      </p>
    )
  }

  if (loading) return <p className="p-4 text-[15px] text-ink-mute">Loading providers…</p>
  if (!data) return <p className="p-4 text-[15px] text-ink-mute">Could not load providers.</p>

  const configured = new Map(data.configured.map((c) => [c.provider, c]))

  return (
    <div className="flex flex-col gap-4 p-4">
      <div>
        <h3 className="text-[17px] font-semibold text-ink">Address lookup</h3>
        <p className="mt-1 text-[15px] text-ink-mute">
          Who turns your addresses into map pins. The free US Census lookup is used
          unless you choose otherwise — it places a lead on the right block, but not
          on the right house. Bringing your own account improves that, and bills to
          you rather than to us.
        </p>
      </div>

      {notice && (
        <p className="rounded-card bg-ok-soft px-4 py-3 text-[15px] text-ok">{notice}</p>
      )}
      {error && (
        <p className="rounded-card bg-bad-soft px-4 py-3 text-[15px] text-bad">{error}</p>
      )}

      <ul className="flex flex-col gap-3">
        {data.providers.map((p) => {
          const row = configured.get(p.id)
          const isActive = data.active === p.id
          const ready = p.adapter === 'live'

          return (
            <li key={p.id} className="panel p-4">
              <div className="flex flex-wrap items-center gap-2">
                <span className="text-[16px] font-semibold text-ink">{p.label}</span>
                {isActive && (
                  <span className="rounded-full bg-accent-soft px-2 py-0.5 text-[12px] font-semibold text-accent">
                    In use
                  </span>
                )}
                <span
                  className={`rounded-full px-2 py-0.5 text-[12px] font-semibold ${STORAGE_TONE[p.storage]}`}
                >
                  {STORAGE_WORD[p.storage]}
                </span>
                {!ready && (
                  <span className="rounded-full bg-surface-sunk px-2 py-0.5 text-[12px] font-semibold text-ink-mute">
                    Not connected yet
                  </span>
                )}
              </div>

              <p className="mt-2 text-[14px] text-ink-mute">{p.accuracy}</p>
              <p className="mt-1 text-[14px] text-ink-mute">
                {p.price} · {p.free} free
              </p>
              <p className="mt-2 text-[14px] text-ink-body">{p.storageNote}</p>

              {row && (
                <p className="mt-2 font-mono text-[13px] text-ink-mute">
                  Key on file: {row.hint}
                </p>
              )}

              <div className="mt-3 flex flex-wrap gap-2">
                {ready && !isActive && (p.needsKey ? !!row : true) && (
                  <Button
                    variant="secondary"
                    disabled={busy}
                    onClick={() => void run((t) => apiSetActiveGeocoder(t, p.id), `Now using ${p.label}.`)}
                  >
                    Use {p.label}
                  </Button>
                )}
                {ready && p.needsKey && (
                  <Button
                    variant="secondary"
                    disabled={busy}
                    onClick={() => {
                      setOpenFor(openFor === p.id ? null : p.id)
                      setKey('')
                    }}
                  >
                    {row ? 'Replace key' : 'Add key'}
                  </Button>
                )}
                {row && (
                  <Button
                    variant="secondary"
                    disabled={busy}
                    onClick={() => void run((t) => apiRemoveGeocoderKey(t, p.id), `Removed the ${p.label} key.`)}
                  >
                    Remove key
                  </Button>
                )}
              </div>

              {openFor === p.id && (
                <div className="mt-3 flex flex-col gap-2">
                  <Field
                    label={`${p.label} API key`}
                    value={key}
                    onChange={(e) => setKey(e.target.value)}
                    placeholder="Paste the key"
                  />
                  <p className="text-[13px] text-ink-mute">
                    Stored encrypted. It is never shown again and never leaves our
                    server — replacing it means pasting a new one.
                    {p.signup ? ` Get one at ${p.signup}.` : ''}
                  </p>
                  <div>
                    <Button
                      disabled={busy || !key.trim()}
                      onClick={() =>
                        void run((t) => apiSaveGeocoderKey(t, p.id, key.trim()), `Saved the ${p.label} key.`)
                      }
                    >
                      Save key
                    </Button>
                  </div>
                </div>
              )}
            </li>
          )
        })}
      </ul>
    </div>
  )
}
