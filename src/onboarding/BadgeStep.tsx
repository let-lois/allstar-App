import { useEffect, useState } from 'react'
import { Button } from '../components/ui/Button'
import { Avatar } from '../components/ui/Avatar'
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
 * The visual here is the plain card; the printed badge with the company's
 * logo and the QR code is the next step's work and replaces this rendering.
 */
export function BadgeStep({ view, busy, error, post, goto }: StepProps) {
  const user = useAppStore((s) => s.user)
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
        setMintError(err instanceof ApiError ? err.message : 'Could not create your badge just now.')
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
      await post('badge')
    } catch (err) {
      setMintError(err instanceof ApiError ? err.message : 'Could not confirm just now.')
    } finally {
      setConfirming(false)
    }
  }

  const name = [view.profile.firstName, view.profile.lastName].filter(Boolean).join(' ') || user?.name || ''
  const title = view.profile.jobTitle || (user ? ROLE_LABEL[user.role] : '')
  const tz = user?.company?.timezone
  const fmt = (ms?: number) =>
    ms ? new Date(ms).toLocaleDateString('en-US', { month: '2-digit', day: '2-digit', year: 'numeric', timeZone: tz }) : '—'

  return (
    <div className="anim-rise">
      <p className="text-[15px] leading-relaxed text-ink-mute">
        This is what homeowners see when you introduce yourself. Check every line — your name and title are what your admin and you entered.
      </p>

      <div className="card mt-5 overflow-hidden p-0" data-testid="badge-preview">
        <div className="bg-surface-tint px-5 py-3">
          <p className="text-[11px] font-semibold uppercase tracking-[0.12em] text-accent">Team member</p>
          <p className="mt-0.5 truncate text-[15px] font-semibold">{user?.company?.name ?? user?.clientName}</p>
        </div>
        <div className="flex items-center gap-4 px-5 py-5">
          <Avatar initials={user?.avatarInitials ?? '?'} name={name} src={user?.avatarUrl} size="lg" className="!h-20 !w-20 !text-[22px]" />
          <div className="min-w-0">
            <p className="truncate text-[19px] font-semibold leading-tight" data-testid="badge-name">{name || 'Your name'}</p>
            <p className="mt-0.5 truncate text-[13.5px] uppercase tracking-[0.06em] text-ink-mute" data-testid="badge-title">{title}</p>
          </div>
        </div>
        <dl className="grid grid-cols-3 gap-2 border-t border-line-soft px-5 py-4 text-[12.5px]">
          <div>
            <dt className="text-ink-mute">ID</dt>
            <dd className="nums font-semibold" data-testid="badge-id">{badge ? `#${badge.id}` : minting ? '…' : '—'}</dd>
          </div>
          <div>
            <dt className="text-ink-mute">Issued</dt>
            <dd className="nums font-semibold">{fmt(badge?.issuedAt)}</dd>
          </div>
          <div>
            <dt className="text-ink-mute">Expires</dt>
            <dd className="nums font-semibold">{fmt(badge?.expiresAt)}</dd>
          </div>
        </dl>
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

      <p className="mt-4 text-[13px] leading-relaxed text-ink-mute">
        Something wrong?{' '}
        <button type="button" className="focusable font-semibold text-accent underline-offset-2 hover:underline" onClick={() => goto('profile')}>
          Fix your name or title
        </button>
        . Email, role and team are set by your admin.
      </p>

      <Button
        size="lg"
        full
        className="mt-6"
        disabled={!badge || busy || confirming || badge.status === 'expired'}
        onClick={() => void confirm()}
        data-testid="badge-confirm"
      >
        {confirming || busy ? 'Saving…' : badge?.status === 'active' ? 'Confirmed — continue' : 'Confirm badge information'}
      </Button>
    </div>
  )
}
