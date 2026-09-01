import { useEffect, useState } from 'react'
import { Button } from '../components/ui/Button'
import { Field } from '../components/ui/Input'
import {
  ApiError,
  apiConnectGhl,
  apiDisconnectGhl,
  apiIntegrations,
  apiSetGhlCalendar,
  type IntegrationDTO,
  type IntegrationQueueDTO,
} from '../lib/http'
import { liveToken } from '../lib/session'
import { relative } from '../lib/format'
import { useAppStore } from '../store/useAppStore'

/**
 * Connecting the company's own CRM.
 *
 * Three things shape this screen, and none of them are about the form fields.
 *
 * **It is write-only.** There is no endpoint that hands a stored token back, so
 * there is nothing to pre-fill and no "edit". Changing a credential means
 * pasting a new one, which is also what happens when a token is rotated — the
 * two cases are the same action rather than two paths through the same form.
 *
 * **The queue is on the same screen as the connection.** A sync queue is the
 * part of an integration that fails invisibly: nothing is on fire, a rep's day
 * looks normal, and the customer's CRM quietly stops receiving work. Putting
 * "12 waiting, 3 failed" next to the credential means the number is in front of
 * the one person who can fix the thing causing it.
 *
 * **Disconnecting says what it will destroy.** Queued work is dropped, because
 * sending it after somebody pressed disconnect is the opposite of what they
 * asked for. That is a real consequence and it is stated before the tap, not
 * discovered after it.
 */
export function IntegrationsPanel() {
  const mode = useAppStore((s) => s.mode)

  const [integration, setIntegration] = useState<IntegrationDTO | null>(null)
  const [queue, setQueue] = useState<IntegrationQueueDTO | null>(null)
  const [loading, setLoading] = useState(true)

  const [token, setToken] = useState('')
  const [locationId, setLocationId] = useState('')
  const [busy, setBusy] = useState(false)
  const [notice, setNotice] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [confirming, setConfirming] = useState(false)
  const [calendarId, setCalendarId] = useState('')
  const [savingCalendar, setSavingCalendar] = useState(false)

  async function load() {
    const t = liveToken()
    if (!t) {
      setLoading(false)
      return
    }
    try {
      const res = await apiIntegrations(t)
      setIntegration(res.integration)
      setQueue(res.queue)
      // Pre-filled, unlike the token: this is a setting rather than a secret, and
      // an admin changing it needs to see what it is now.
      const cfg = res.integration?.config as { calendarId?: string } | undefined
      setCalendarId(typeof cfg?.calendarId === 'string' ? cfg.calendarId : '')
    } catch {
      // A failure to read the status is not worth an alarm on this screen —
      // the connect form still works, and the next load will say.
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => {
    void load()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  async function connect() {
    const t = liveToken()
    if (!t) {
      setError('Connecting needs a live account. The demo has no CRM to talk to.')
      return
    }
    setBusy(true)
    setError(null)
    setNotice(null)
    try {
      const res = await apiConnectGhl(t, { token: token.trim(), locationId: locationId.trim() })
      setIntegration(res.integration)
      // Clearing the field matters: the token should not sit in a form on a
      // screen somebody might walk away from.
      setToken('')
      setNotice(
        res.locationName
          ? `Connected to ${res.locationName}.`
          : 'Connected. GoHighLevel accepted the token.',
      )
      await load()
    } catch (err) {
      setError(
        err instanceof ApiError ? err.message : 'Could not connect. Nothing was saved.',
      )
    } finally {
      setBusy(false)
    }
  }

  async function disconnect() {
    const t = liveToken()
    if (!t) return
    setBusy(true)
    setError(null)
    setNotice(null)
    try {
      const res = await apiDisconnectGhl(t)
      setIntegration({ provider: 'ghl', connected: false })
      setQueue(null)
      setConfirming(false)
      setNotice(
        res.dropped > 0
          ? `Disconnected. ${res.dropped} queued update${res.dropped === 1 ? '' : 's'} discarded.`
          : 'Disconnected.',
      )
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not disconnect.')
    } finally {
      setBusy(false)
    }
  }

  if (loading) {
    return (
      <section className="card p-5">
        <p className="text-[13px] text-ink-mute">Checking…</p>
      </section>
    )
  }

  const connected = !!integration?.connected
  const broken = integration?.status === 'broken' || integration?.status === 'unreadable'

  return (
    <div className="space-y-4">
      <section className="card p-5">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div>
            <h2 className="text-sm font-bold">GoHighLevel</h2>
            <p className="mt-0.5 text-xs leading-relaxed text-ink-mute">
              Push what your reps do in the field into your own CRM, so follow-up runs
              from the system your office already uses.
            </p>
          </div>
          <span
            className={`shrink-0 rounded-full border px-2.5 py-1 text-[11.5px] font-semibold ${
              broken
                ? 'border-bad text-bad'
                : connected
                  ? 'border-good text-good'
                  : 'border-line text-ink-mute'
            }`}
          >
            {broken ? 'Needs attention' : connected ? 'Connected' : 'Not connected'}
          </span>
        </div>

        {connected && (
          <dl className="mt-4 grid gap-x-6 gap-y-2 border-t border-line-soft pt-4 text-[13px] sm:grid-cols-2">
            <Row label="Sub-account" value={integration?.locationId ?? '—'} />
            <Row label="Token" value={integration?.tokenHint ?? '—'} />
            <Row
              label="Last successful sync"
              value={integration?.lastOkAt ? relative(integration.lastOkAt) : 'Not yet'}
            />
            {queue && (
              <Row
                label="Waiting to send"
                value={
                  queue.pending === 0 && queue.failed === 0
                    ? 'Nothing queued'
                    : `${queue.pending} pending${queue.failed ? `, ${queue.failed} failed` : ''}`
                }
                tone={queue.failed > 0 ? 'bad' : undefined}
              />
            )}
          </dl>
        )}

        {connected && integration?.lastError && (
          <p className="mt-3 rounded-card border border-bad/40 bg-bad/5 p-3 text-[13px] leading-relaxed text-bad">
            {integration.lastError}
            {integration.lastErrorAt && (
              <span className="text-ink-mute"> · {relative(integration.lastErrorAt)}</span>
            )}
          </p>
        )}
      </section>

      {/*
        Appointments are opt-in, and the absence of a calendar is a real setting
        rather than an incomplete one.

        GoHighLevel has no default calendar to fall back on, so without an id
        there is nowhere to book. The app therefore does not queue appointments
        at all when this is empty — which is why the copy says they are off
        rather than implying something is broken. Before this field existed every
        appointment queued an event that could never send, and the failed count
        above climbed forever with nothing an admin could do about it.
      */}
      {connected && (
        <section className="card p-5">
          <h2 className="text-sm font-bold">Appointments</h2>
          <p className="mt-0.5 text-xs leading-relaxed text-ink-mute">
            {calendarId
              ? 'Appointments your reps book are added to this GoHighLevel calendar.'
              : 'Appointments are not being sent to GoHighLevel. Add a calendar ID to turn that on.'}
          </p>
          <form
            className="mt-4"
            onSubmit={async (e) => {
              e.preventDefault()
              const t = liveToken()
              if (!t) return
              setSavingCalendar(true)
              setError(null)
              setNotice(null)
              try {
                const res = await apiSetGhlCalendar(t, calendarId.trim())
                setNotice(
                  res.calendarId
                    ? 'Saved. Appointments your reps book will be added to that calendar.'
                    : 'Cleared. Appointments will not be sent to GoHighLevel.',
                )
                await load()
              } catch (err) {
                setError(err instanceof ApiError ? err.message : 'Could not save the calendar.')
              } finally {
                setSavingCalendar(false)
              }
            }}
          >
            <Field
              label="Calendar ID"
              autoComplete="off"
              spellCheck={false}
              value={calendarId}
              onChange={(e) => setCalendarId(e.target.value)}
              placeholder="Not set — appointments stay in Allstar"
              hint="In GoHighLevel: Calendars, then the one you want. Copy just the ID. Leave it empty to stop sending appointments."
            />
            <div className="mt-3 flex justify-end">
              <Button type="submit" disabled={savingCalendar}>
                {savingCalendar ? 'Saving…' : 'Save calendar'}
              </Button>
            </div>
          </form>
        </section>
      )}

      {/*
        Shown whether or not something is already connected: rotating a token is
        the same action as connecting one, and hiding the form behind an "edit"
        would make the common maintenance job the hidden one.
      */}
      <section className="card p-5">
        <h2 className="text-sm font-bold">{connected ? 'Replace the connection' : 'Connect'}</h2>
        <p className="mt-0.5 text-xs leading-relaxed text-ink-mute">
          In GoHighLevel, open the sub-account you want Allstar to write to, then
          Settings → Private Integrations, and create one. Paste the token here along
          with that sub-account&rsquo;s location ID. We check it works before saving it.
        </p>

        <div className="mt-4 grid gap-4 sm:grid-cols-2">
          <Field
            label="Private Integration Token"
            type="password"
            autoComplete="off"
            spellCheck={false}
            value={token}
            onChange={(e) => setToken(e.target.value)}
            placeholder="pit-…"
            hint="Stored encrypted. It is never shown again after this."
          />
          <Field
            label="Location ID"
            autoComplete="off"
            spellCheck={false}
            value={locationId}
            onChange={(e) => setLocationId(e.target.value)}
            placeholder="The sub-account this writes to"
            hint="Getting this wrong sends your leads into somebody else's account."
          />
        </div>

        <div className="mt-4 flex flex-wrap items-center justify-end gap-3">
          {notice && <span className="text-xs font-medium text-good">{notice}</span>}
          {error && <span className="text-xs font-medium text-bad">{error}</span>}
          <Button
            size="sm"
            disabled={busy || mode !== 'live' || !token.trim() || !locationId.trim()}
            onClick={() => void connect()}
          >
            {busy ? 'Checking…' : connected ? 'Replace' : 'Connect'}
          </Button>
        </div>
      </section>

      {connected && (
        <section className="card p-5">
          <h2 className="text-sm font-bold">Disconnect</h2>
          {confirming ? (
            <>
              <p className="mt-1 text-[13px] leading-relaxed text-ink-soft">
                Allstar stops sending to GoHighLevel.{' '}
                {queue && queue.pending > 0
                  ? `${queue.pending} update${queue.pending === 1 ? '' : 's'} still waiting to send will be discarded.`
                  : 'Nothing is currently waiting to send.'}{' '}
                Records already in your CRM are left alone, and reconnecting later picks
                up where this left off rather than starting again.
              </p>
              <div className="mt-4 flex flex-wrap items-center justify-end gap-3">
                <Button size="sm" variant="ghost" onClick={() => setConfirming(false)}>
                  Keep it connected
                </Button>
                <Button size="sm" variant="danger" disabled={busy} onClick={() => void disconnect()}>
                  {busy ? 'Disconnecting…' : 'Disconnect'}
                </Button>
              </div>
            </>
          ) : (
            <div className="mt-1 flex flex-wrap items-center justify-between gap-3">
              <p className="text-[13px] text-ink-mute">
                Stop sending field activity to GoHighLevel.
              </p>
              <Button size="sm" variant="ghost" onClick={() => setConfirming(true)}>
                Disconnect
              </Button>
            </div>
          )}
        </section>
      )}
    </div>
  )
}

function Row({ label, value, tone }: { label: string; value: string; tone?: 'bad' }) {
  return (
    <div className="flex items-baseline justify-between gap-3 sm:block">
      <dt className="text-ink-mute">{label}</dt>
      <dd className={`font-semibold ${tone === 'bad' ? 'text-bad' : 'text-ink'}`}>{value}</dd>
    </div>
  )
}
