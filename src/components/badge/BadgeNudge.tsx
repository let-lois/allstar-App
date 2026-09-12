import { useEffect, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { Button } from '../ui/Button'
import * as db from '../../lib/db'
import { useAppStore } from '../../store/useAppStore'

/**
 * The one card on Today about the badge, for people who never had one.
 *
 * Everyone who joined before badges existed was marked onboarded by the
 * backfill — rightly, they had been working for months — which also means
 * nothing ever walked them to a badge. This is the nudge: a card on Today
 * that says so and opens My badge, shown only while the server says there is
 * no active badge and only in a live account.
 *
 * Dismissable per person per phone, and it stays dismissed — a rep who says
 * "not now" is not asked again every morning. It comes back on its own only
 * if the reason changes: an active badge that later expires is a new fact,
 * and a new key.
 */
const dismissKey = (userId: string, reason: string) => `allstar.badge-nudge.${userId}.${reason}`

export function BadgeNudge() {
  const nav = useNavigate()
  const user = useAppStore((s) => s.user)
  const mode = useAppStore((s) => s.mode)
  const [dismissed, setDismissed] = useState<boolean | null>(null)

  const status = user?.badge?.status ?? 'none'
  const reason = status === 'active' ? null : status
  const key = user && reason ? dismissKey(user.id, reason) : null

  useEffect(() => {
    if (!key) return
    let alive = true
    setDismissed(null)
    void db.metaGet<boolean>(key).then((v) => alive && setDismissed(!!v))
    return () => {
      alive = false
    }
  }, [key])

  if (mode !== 'live' || !user || !reason || !key) return null
  // Only a live user whose server-side onboarding is complete sees Today at
  // all; anyone else is in the flow, where the badge has its own step.
  if (user.onboarding && user.onboarding.status !== 'complete') return null
  if (dismissed !== false) return null

  const copy =
    reason === 'none'
      ? { title: 'Create your team badge', body: 'Homeowners see it when you introduce yourself. It takes a minute, and the id is yours for good.', cta: 'Create badge' }
      : reason === 'expired'
        ? { title: 'Your badge has expired', body: 'Renew it to keep the same id with a new date. You confirm it again afterwards.', cta: 'Renew badge' }
        : { title: 'Confirm your badge', body: 'Your badge is made but not yet confirmed. Check every line and confirm it.', cta: 'Confirm badge' }

  return (
    <div className="card flex items-start gap-3 p-4" data-testid="badge-nudge" data-reason={reason} role="status">
      <div className="min-w-0 flex-1">
        <p className="text-[15px] font-semibold">{copy.title}</p>
        <p className="mt-0.5 text-[13px] leading-snug text-ink-mute">{copy.body}</p>
        <div className="mt-3 flex gap-2">
          <Button size="sm" onClick={() => nav('/badge')} data-testid="badge-nudge-go">
            {copy.cta}
          </Button>
          <Button
            size="sm"
            variant="secondary"
            data-testid="badge-nudge-dismiss"
            onClick={() => {
              setDismissed(true)
              void db.metaSet(key, true)
            }}
          >
            Not now
          </Button>
        </div>
      </div>
    </div>
  )
}
