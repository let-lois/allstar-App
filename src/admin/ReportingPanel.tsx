import { useEffect, useMemo, useState } from 'react'
import { Button } from '../components/ui/Button'
import { ApiError, apiSetTimezone } from '../lib/http'
import { liveToken } from '../lib/session'
import { useAppStore } from '../store/useAppStore'

/**
 * The company's calendar.
 *
 * One setting, and it deserves its own screen because of what it does rather
 * than how big it is: it decides which day a rep's work is counted on. Cut in
 * UTC — as this was — a crew in Texas has every door knocked after six or seven
 * in the evening land in tomorrow's numbers, while their own phones count them
 * as today. Nothing errors. The console and the board just quietly disagree
 * about the same evening.
 *
 * Two things this screen has to be honest about, because both surprise people:
 *
 *   Changing it does not move work that has already been counted. Those rows
 *   were written on the old calendar and stay there until history is rebuilt,
 *   which is a deliberate operation with a backup taken first. A dropdown that
 *   silently rewrites a year of reporting is not a dropdown.
 *
 *   It is the company's zone, not the rep's. A rep who drives across a state
 *   line should not start a new reporting day at lunchtime, and a manager
 *   comparing two reps needs both counted the same way.
 */

/** The zones a US roofing company plausibly works in, plus UTC as the default. */
const ZONES = [
  { id: 'America/New_York', label: 'Eastern — New York' },
  { id: 'America/Chicago', label: 'Central — Chicago, Dallas' },
  { id: 'America/Denver', label: 'Mountain — Denver' },
  { id: 'America/Phoenix', label: 'Mountain, no DST — Phoenix' },
  { id: 'America/Los_Angeles', label: 'Pacific — Los Angeles' },
  { id: 'America/Anchorage', label: 'Alaska' },
  { id: 'Pacific/Honolulu', label: 'Hawaii' },
  { id: 'UTC', label: 'UTC — the default, and wrong for anyone who works evenings' },
]

export function ReportingPanel() {
  const mode = useAppStore((s) => s.mode)
  const stored = useAppStore((s) => s.timezone)
  const refreshFromServer = useAppStore((s) => s.refreshFromServer)

  const [choice, setChoice] = useState(stored || 'UTC')
  useEffect(() => setChoice(stored || 'UTC'), [stored])

  const [saving, setSaving] = useState(false)
  const [notice, setNotice] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)

  /*
    The device's own zone, offered as a hint rather than applied.
    Whoever is setting this is usually sitting in the office they are setting it
    for, so it is nearly always the right answer — but "nearly always" is not
    grounds for choosing on their behalf.
  */
  const device = useMemo(() => {
    try {
      return Intl.DateTimeFormat().resolvedOptions().timeZone || ''
    } catch {
      return ''
    }
  }, [])

  /** What the boundary means in practice, in the words a person would use. */
  const preview = useMemo(() => {
    try {
      const now = new Date()
      const local = new Intl.DateTimeFormat('en-US', {
        timeZone: choice,
        weekday: 'short',
        hour: 'numeric',
        minute: '2-digit',
      }).format(now)
      return local
    } catch {
      return null
    }
  }, [choice])

  const unset = !stored || stored === 'UTC'

  async function save() {
    const token = liveToken()
    if (!token) {
      setError('Setting this needs a live account. The demo has no reporting to bucket.')
      return
    }
    setSaving(true)
    setError(null)
    setNotice(null)
    try {
      await apiSetTimezone(token, choice)
      await refreshFromServer()
      setNotice('Saved. New work is counted on this calendar from now on.')
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not save. Nothing was changed.')
    } finally {
      setSaving(false)
    }
  }

  return (
    <div className="space-y-4">
      <section className="card p-5">
        <h2 className="text-sm font-bold">Reporting day</h2>
        <p className="mt-0.5 text-xs leading-relaxed text-ink-mute">
          Which calendar a day&rsquo;s numbers are counted on. Everything on the dashboard
          and in Reports is bucketed by it.
        </p>

        {unset && (
          <p className="mt-3 rounded-card border border-warn/40 bg-warn/5 p-3 text-[13px] leading-relaxed text-warn">
            Currently UTC, which is the default rather than a choice. If your crew knocks
            in the evening, those doors are being counted on the next day&rsquo;s numbers.
          </p>
        )}

        <label className="mt-4 block">
          <span className="mb-1.5 block text-[13px] font-medium text-ink-soft">Timezone</span>
          <select
            value={choice}
            onChange={(e) => setChoice(e.target.value)}
            className="field h-[52px] w-full"
          >
            {ZONES.map((z) => (
              <option key={z.id} value={z.id}>
                {z.label}
              </option>
            ))}
            {/* A zone set outside this list stays selectable rather than silently reset. */}
            {stored && !ZONES.some((z) => z.id === stored) && (
              <option value={stored}>{stored}</option>
            )}
          </select>
        </label>

        {preview && (
          <p className="mt-2 text-[13px] text-ink-mute">
            It is <span className="font-semibold text-ink">{preview}</span> there right now.
            {device && device !== choice && (
              <> This device is set to {device}.</>
            )}
          </p>
        )}

        <div className="mt-4 flex flex-wrap items-center justify-end gap-3">
          {notice && <span className="text-xs font-medium text-good">{notice}</span>}
          {error && <span className="text-xs font-medium text-bad">{error}</span>}
          <Button
            size="sm"
            disabled={saving || mode !== 'live' || choice === stored}
            onClick={() => void save()}
          >
            {saving ? 'Saving…' : 'Save'}
          </Button>
        </div>
      </section>

      <section className="card p-5">
        <h2 className="text-sm font-bold">Numbers already counted</h2>
        <p className="mt-1 text-[13px] leading-relaxed text-ink-soft">
          Changing the timezone applies to work recorded from now on. Days already in
          your reports were counted on the old calendar and stay where they are — a
          setting should not be able to rewrite a year of history behind your back.
        </p>
        <p className="mt-3 text-[13px] leading-relaxed text-ink-mute">
          Rebuilding them is a separate, deliberate step, run against a backup by
          whoever administers the deployment. Every figure is recomputed from the
          visits themselves, so nothing is invented — but it does move numbers between
          days, and it is worth knowing that before it happens rather than after.
        </p>
      </section>
    </div>
  )
}
