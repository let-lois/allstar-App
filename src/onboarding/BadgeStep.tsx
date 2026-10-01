import { useEffect, useState } from 'react'
import { describeError } from '../lib/errors'
import { Button } from '../components/ui/Button'
import { TeamBadge } from '../components/badge/TeamBadge'
import { ApiError, apiConfirmBadge, apiMintBadge } from '../lib/http'
import { ROLE_LABEL } from '../lib/roles'
import { liveToken } from '../lib/session'
import { useAppStore } from '../store/useAppStore'
import type { BadgeInfo } from '../types'
import type { StepProps } from './steps'

/**
 * Step 4 — the badge.
 *
 * Minting happens the moment this screen opens, once: the server returns the
 * same badge on every visit after the first, so the id printed here is the id
 * for good. What the person does here is *read* it and say it is right —
 * confirmation is its own act with its own timestamp, and the flow will not
 * move on without it.
 *
 * A badge cannot be minted without a name to print on it. If the server says
 * so, the screen offers the way back to the profile rather than a dead end.
 *
 * The badge itself is `TeamBadge`, the same rendering More and the admin use,
 * so what is confirmed here is what everyone else sees.
 */
export function BadgeStep({ view, busy, error, post, goto }: StepProps) {
  const user = useAppStore((s) => s.user)
  const refreshMe = useAppStore((s) => s.refreshMe)
  const [badge, setBadge] = useState<BadgeInfo | null>(view.badge)
  const [minting, setMinting] = useState(!view.badge)
  const [mintError, setMintError] = useState<string | null>(null)
  const [needsName, setNeedsName] = useState(false)
  const [confirming, setConfirming] = useState(false)

  useEffect(() => {
    if (badge) return
    const token = liveToken()
    if (!token) return
    let alive = true
    void apiMintBadge(token)
      .then((r) => alive && setBadge(r.badge))
      .catch((err) => {
        if (!alive) return
        setMintError(describeError(err, 'Could not create your badge just now.'))
        if (err instanceof ApiError && err.status === 409) setNeedsName(true)
      })
      .finally(() => alive && setMinting(false))
    return () => {
      alive = false
    }
  }, [badge])

  async function confirm() {
    const token = liveToken()
    if (!token) return
    setConfirming(true)
    try {
      const r = await apiConfirmBadge(token)
      setBadge(r.badge)
      const moved = await post('badge')
      if (moved) void refreshMe()
    } catch (err) {
      setMintError(describeError(err, 'Could not confirm just now.'))
    } finally {
      setConfirming(false)
    }
  }

  // The card is blank without a face on it, so it cannot be confirmed without
  // one — the same rule the checklist applies, met here, where the card is.
  const hasPhoto = view.profile.hasPhoto || !!user?.avatarUrl
  const name = [view.profile.firstName, view.profile.lastName].filter(Boolean).join(' ') || user?.name || ''
  const title = view.profile.jobTitle || (user ? ROLE_LABEL[user.role] : '')
  const company = user?.company ?? { name: user?.clientName ?? '', timezone: undefined }

  return (
    <div className="anim-rise">
      <p className="text-[15px] leading-relaxed text-ink-mute">
        This is what homeowners see when you introduce yourself. Check every line — your name and title are what your admin and you entered.
      </p>

      <div className="mt-5" data-testid="badge-preview">
        <TeamBadge
          badge={badge}
          name={name}
          title={title}
          company={company}
          avatarUrl={user?.avatarUrl}
          avatarInitials={user?.avatarInitials ?? '?'}
          minting={minting}
        />
      </div>

      {(mintError || error) && (
        <div className="mt-4 rounded-field bg-bad-bg px-3 py-2.5 text-[14px] font-medium text-bad" role="alert">
          <p>{mintError ?? error}</p>
          {needsName && (
            <Button size="sm" variant="secondary" className="mt-2" onClick={() => goto('profile')}>
              Add your name
            </Button>
          )}
        </div>
      )}

      {!hasPhoto && (
        <div className="mt-4 rounded-field bg-warn-bg px-3 py-2.5 text-[14px] text-warn" data-testid="badge-needs-photo">
          <p className="font-medium">Your badge needs your photo before it can be confirmed.</p>
          <Button size="sm" variant="secondary" className="mt-2" onClick={() => goto('profile')} data-testid="badge-add-photo">
            Add your photo
          </Button>
        </div>
      )}

      <p className="mt-4 text-[13px] leading-relaxed text-ink-mute">
        Something wrong?{' '}
        <button type="button" className="focusable inline-flex min-h-tap items-center font-semibold text-accent underline-offset-2 hover:underline" onClick={() => goto('profile')}>
          Fix your name or title
        </button>
        . Email, role and team are set by your admin.
      </p>

      <Button
        size="lg"
        full
        className="mt-6"
        disabled={!badge || !hasPhoto || busy || confirming || badge.status === 'expired'}
        onClick={() => void confirm()}
        data-testid="badge-confirm"
      >
        {confirming || busy ? 'Saving…' : badge?.status === 'active' ? 'Confirmed — continue' : 'Confirm badge information'}
      </Button>
    </div>
  )
}
