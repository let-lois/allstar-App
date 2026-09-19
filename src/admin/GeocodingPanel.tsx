import { useEffect, useState } from 'react'
import { Button } from '../components/ui/Button'
import { Field } from '../components/ui/Input'
import {
  apiGeocoders,
  apiRemoveGeocoderKey,
  apiSaveGeocoderKey,
  apiSetActiveGeocoder,
  type GeocodeProviderDTO,
  type GeocodeUsageDTO,
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
  permanent: 'bg-good-bg text-good',
  conditional: 'bg-warn-bg text-warn',
  temporary: 'bg-bad-bg text-bad',
}

/**
 * What the company is actually spending on address lookups.
 *
 * Deliberately not a bill and never presented as one. Three separate facts,
 * each qualified by how much we can really know about it:
 *
 *   - **Who charges.** Nobody here does. The key is the company's own and the
 *     vendor invoices them for it, which is the part an operator most often has
 *     backwards when they ask what a lookup costs.
 *   - **What has gone through.** A count of the lookups this app sent on the
 *     active key, which is a floor: the same key used anywhere else is invisible
 *     to us and very visible to the vendor.
 *   - **What is left of the allowance.** Derived from that floor, so it is a
 *     ceiling — it can only be optimistic, and it says so.
 *
 * The prices in the catalogue below came from vendors' public pages rather than
 * from an account, so nothing here is a quote and the copy does not pretend it
 * is. A number an operator trusts and should not is worse on this screen than
 * no number at all.
 */
function BillingSummary({
  active,
  usage,
}: {
  active: GeocodeProviderDTO | null
  usage: GeocodeUsageDTO
}) {
  const n = (v: number) => v.toLocaleString()

  // Census, or nothing chosen: there is no key, so there is no bill, and the
  // counters would only invite the question of what they are costing.
  if (!active || !active.needsKey) {
    return (
      <div className="rounded-card bg-surface-sunk px-4 py-3">
        <p className="text-[15px] font-semibold text-ink">
          Address lookups are costing you nothing.
        </p>
        <p className="mt-1 text-[14px] text-ink-mute">
          {active?.label ?? 'The US Census lookup'} needs no account and bills nobody.{' '}
          {n(usage.month)} address{usage.month === 1 ? '' : 'es'} looked up this month,{' '}
          {n(usage.today)} today.
        </p>
      </div>
    )
  }

  const period = active.freePeriod
  const spent = period === 'day' ? usage.today : period === 'month' ? usage.month : 0
  const left = active.freeCount === null ? null : Math.max(0, active.freeCount - spent)
  const word = period === 'day' ? 'today' : 'this month'

  return (
    <div className="rounded-card bg-surface-sunk px-4 py-3">
      <p className="text-[15px] font-semibold text-ink">
        {active.label} bills you directly — we never charge for a lookup.
      </p>
      <p className="mt-1 text-[14px] text-ink-mute">
        {n(usage.month)} address{usage.month === 1 ? '' : 'es'} looked up this month,{' '}
        {n(usage.today)} today, on the key you pasted here.
      </p>

      {left !== null && period && (
        <p className="mt-1 text-[14px] text-ink-mute">
          {left > 0
            ? `About ${n(left)} of ${active.label}’s ${n(active.freeCount ?? 0)} free lookups ${word} left, then ${active.price}.`
            : `${active.label}’s free allowance for ${word} looks spent — further lookups are billed at ${active.price}.`}
        </p>
      )}
      {left === null && (
        <p className="mt-1 text-[14px] text-ink-mute">
          {active.label} prices by plan rather than per thousand, so we cannot put
          a figure on it — check the account.
        </p>
      )}

      {/*
        The qualification belongs next to the numbers, not in a footnote. An
        operator who reads "8,796 left" and plans an import around it needs to
        know in the same breath that the figure only counts what went through
        this app.
      */}
      <p className="mt-2 text-[13px] text-ink-mute">
        Counted from what this app sent, so treat it as a minimum: the same key
        used anywhere else adds to {active.label}’s count and not to ours. Prices
        shown here are the vendors’ published rates for orientation, not a quote
        — your account is the authority.
      </p>
    </div>
  )
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
  const active = data.providers.find((p) => p.id === data.active) ?? null

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

      {/*
        --- what it is costing, right now -------------------------------------

        The panel was already fetching `usage` and throwing it away, which is
        how "I'm not sure about the billing" happens on a screen that lists a
        price beside every vendor: a list price answers what a lookup costs and
        not what this company has spent, and those are the same sentence only
        to somebody who already knows how many lookups they have made.

        So this says the three things an operator actually needs — who bills
        them, how much has gone through the key, and how much of the allowance
        is left — and says which of them are floors rather than totals. The
        counter only sees lookups this app sent; the same key pasted into
        anything else adds to the vendor's count and not to ours, and claiming
        otherwise would be the one error that costs real money.
      */}
      <BillingSummary active={active} usage={data.usage ?? { today: 0, month: 0 }} />

      {notice && (
        <p className="rounded-card bg-good-bg px-4 py-3 text-[15px] text-good">{notice}</p>
      )}
      {error && (
        <p className="rounded-card bg-bad-bg px-4 py-3 text-[15px] text-bad">{error}</p>
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
                  <span className="rounded-full bg-info-bg px-2 py-0.5 text-[12px] font-semibold text-info">
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
                List price {p.price} · {p.free} free
              </p>
              <p className="mt-2 text-[14px] text-ink-soft">{p.storageNote}</p>

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
