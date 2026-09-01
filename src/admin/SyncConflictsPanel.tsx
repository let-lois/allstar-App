import { useCallback, useEffect, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { Button } from '../components/ui/Button'
import { apiReviewSyncConflict, apiSyncConflicts, type SyncConflictDTO } from '../lib/http'
import { liveToken } from '../lib/session'
import { relative } from '../lib/format'

/**
 * Late work that landed on a lead somebody had already moved.
 *
 * The rule is settled and this screen does not argue with it: a rep at the door
 * outranks an edit made from a desk, so their answer applied and the lead
 * carries it. What this fixes is that until now the office edit disappeared and
 * nobody was told — the manager who rescheduled an appointment on Wednesday
 * found out on Saturday, from the homeowner.
 *
 * So it is not a queue of decisions. There is nothing to approve or revert
 * here; the outcome already happened. It is a short list of "you should
 * probably ring this person", which is why the only action is acknowledging it.
 *
 * On the dashboard rather than in Settings because managers do not have
 * Settings, and a manager is exactly who this is for. It renders nothing at all
 * when the list is empty, which on a healthy account is almost always.
 */
export function SyncConflictsPanel() {
  const nav = useNavigate()
  const [conflicts, setConflicts] = useState<SyncConflictDTO[]>([])
  const [busy, setBusy] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)

  const load = useCallback(async () => {
    const token = liveToken()
    // The demo has no server to ask, and an empty panel is the right answer
    // there rather than an error nobody can act on.
    if (!token) return
    try {
      const { conflicts } = await apiSyncConflicts(token)
      setConflicts(conflicts)
    } catch {
      // Deliberately silent. This is a secondary panel on a screen full of
      // numbers, and a red box because a background fetch failed would be the
      // loudest thing on a dashboard that is otherwise fine.
    }
  }, [])

  useEffect(() => {
    void load()
  }, [load])

  async function acknowledge(id: string) {
    const token = liveToken()
    if (!token) return
    setBusy(id)
    setError(null)
    try {
      await apiReviewSyncConflict(token, id)
      setConflicts((cs) => cs.filter((c) => c.id !== id))
    } catch {
      setError('That could not be marked as reviewed. It is still on the list.')
    } finally {
      setBusy(null)
    }
  }

  if (conflicts.length === 0) return null

  return (
    <section className="mt-3 rounded-card border border-warn/40 bg-warn/5 p-4">
      <h2 className="text-sm font-semibold text-warn">
        {conflicts.length} lead{conflicts.length === 1 ? '' : 's'} changed while a rep was
        offline
      </h2>
      <p className="mt-1 text-[13px] text-ink-soft">
        The rep was at the door, so their answer was kept — the change made here in the
        meantime was overwritten. Worth a call before somebody finds out the hard way.
      </p>

      <ul className="mt-3 space-y-2">
        {conflicts.map((c) => (
          <li
            key={c.id}
            className="flex flex-wrap items-center gap-x-3 gap-y-1 rounded-lg bg-surface p-3"
          >
            <button
              onClick={() => nav(`/admin/leads?q=${encodeURIComponent(c.address)}`)}
              className="focusable text-left text-sm font-semibold hover:text-accent"
            >
              {c.address}
            </button>
            <span className="text-[13px] text-ink-soft">
              {c.repName ?? 'A rep'} logged {describe(c)}{' '}
              {Math.round(c.lateByHours / 24)} days before it reached us
              {/* Both timestamps, because "3 days late" is the summary and the
                  dates are what a manager needs to reconstruct the week. */}
              <span className="text-ink-mute">
                {' '}
                ({relative(c.actedAt)}, arrived {relative(c.arrivedAt)})
              </span>
            </span>
            <span className="ml-auto">
              <Button
                size="sm"
                variant="secondary"
                disabled={busy === c.id}
                onClick={() => acknowledge(c.id)}
              >
                {busy === c.id ? 'Saving…' : 'Reviewed'}
              </Button>
            </span>
          </li>
        ))}
      </ul>

      {error && <p className="mt-2 text-[13px] text-bad">{error}</p>}
    </section>
  )
}

/** What the rep actually did, in the words the console uses elsewhere. */
function describe(c: SyncConflictDTO): string {
  const outcome = typeof c.detail?.outcome === 'string' ? c.detail.outcome : null
  if (c.kind === 'visit.complete') {
    return outcome ? `a visit (${outcome.replace(/_/g, ' ')})` : 'a visit'
  }
  const status = typeof c.detail?.status === 'string' ? c.detail.status : null
  return status ? `a status change to ${status}` : 'a change'
}
