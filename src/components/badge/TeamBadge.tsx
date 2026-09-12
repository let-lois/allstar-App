import { useMemo } from 'react'
import { Avatar } from '../ui/Avatar'
import { qrModules, qrPath } from '../../lib/qr'
import { verifyUrl } from '../../lib/badge'
import type { BadgeInfo } from '../../types'

/**
 * The team member badge as a homeowner sees it held up at the door.
 *
 * One rendering for every place it appears — the onboarding step, My badge in
 * More, the admin's member page later — so the badge a rep confirmed is the
 * badge everyone else looks at. Nothing here is fetched: the parent hands in
 * what the server said, and the component draws it. That is what makes it
 * honest offline and what keeps "viewing the badge" from ever minting one.
 *
 * The company sits at the top. A logo the admin uploaded is used as-is; with
 * no logo, the company's name is set as a lockup so the badge is never
 * headed by an empty rectangle. The QR code opens this badge's public
 * verification page — the homeowner's real question is "is this person who
 * they say they are", and that page answers it with the name, the photo, the
 * company and whether the badge is still good. There is no code until there
 * is a badge, because there is nothing to verify.
 */
export interface TeamBadgeProps {
  badge: BadgeInfo | null
  name: string
  title: string
  company: { name: string; timezone?: string; logoUrl?: string; website?: string }
  avatarUrl?: string
  avatarInitials: string
  /** Shown while the server is minting — the id slot reads as pending. */
  minting?: boolean
  /** Off on the verification page itself, where a code to this page is noise. */
  showQr?: boolean
  className?: string
}

export const BADGE_STATUS_LABEL: Record<BadgeInfo['status'], string> = {
  none: 'Not created',
  awaiting_confirmation: 'Awaiting confirmation',
  active: 'Active',
  expired: 'Expired',
}

export function TeamBadge({ badge, name, title, company, avatarUrl, avatarInitials, minting = false, showQr = true, className = '' }: TeamBadgeProps) {
  const target = badge ? verifyUrl(badge.id) : undefined
  const qr = useMemo(() => (target && showQr ? qrModules(target) : null), [target, showQr])
  const status = badge?.status ?? 'none'
  const tz = company.timezone
  const fmt = (ms?: number) =>
    ms ? new Date(ms).toLocaleDateString('en-US', { month: '2-digit', day: '2-digit', year: 'numeric', timeZone: tz }) : '—'

  return (
    <div
      className={`card overflow-hidden p-0 ${className}`}
      data-testid="team-badge"
      data-status={status}
      role="group"
      aria-label={`Team member badge for ${name || 'you'}`}
    >
      {/* --- the company ------------------------------------------------ */}
      <div className="flex items-center gap-3 bg-surface-tint px-5 py-3.5">
        {company.logoUrl ? (
          <img src={company.logoUrl} alt="" className="h-9 max-w-[140px] shrink-0 object-contain" data-testid="badge-logo" />
        ) : (
          <div
            className="flex h-9 w-9 shrink-0 items-center justify-center rounded-md bg-accent text-[15px] font-bold text-white"
            aria-hidden="true"
            data-testid="badge-lockup"
          >
            {company.name.trim().charAt(0).toUpperCase() || '?'}
          </div>
        )}
        <div className="min-w-0 flex-1">
          <p className="truncate text-[15px] font-semibold leading-tight" data-testid="badge-company">{company.name}</p>
          <p className="mt-0.5 text-[11px] font-semibold uppercase tracking-[0.12em] text-accent">Team member</p>
        </div>
        <span
          className={`shrink-0 rounded-full px-2 py-0.5 text-[11px] font-semibold ${
            status === 'active' ? 'bg-good-bg text-good' : status === 'expired' ? 'bg-bad-bg text-bad' : 'bg-warn-bg text-warn'
          }`}
          data-testid="badge-status"
        >
          {BADGE_STATUS_LABEL[status]}
        </span>
      </div>

      {/* --- the person ------------------------------------------------- */}
      <div className="flex items-center gap-4 px-5 py-5">
        <Avatar initials={avatarInitials} name={name} src={avatarUrl} size="lg" className="!h-20 !w-20 !text-[22px]" />
        <div className="min-w-0 flex-1">
          <p className="truncate text-[20px] font-semibold leading-tight" data-testid="badge-name">{name || 'Your name'}</p>
          <p className="mt-1 truncate text-[13.5px] uppercase tracking-[0.06em] text-ink-mute" data-testid="badge-title">{title}</p>
          <p className="nums mt-2 text-[15px] font-semibold tracking-[0.02em]" data-testid="badge-id">
            {badge ? `#${badge.id}` : minting ? 'Creating…' : 'No badge yet'}
          </p>
        </div>
      </div>

      {/* --- dates and the code ---------------------------------------- */}
      <div className="flex items-end justify-between gap-4 border-t border-line-soft px-5 py-4">
        <dl className="grid gap-2 text-[12.5px]">
          <div>
            <dt className="text-ink-mute">Issued</dt>
            <dd className="nums font-semibold" data-testid="badge-issued">{fmt(badge?.issuedAt)}</dd>
          </div>
          <div>
            <dt className="text-ink-mute">Expires</dt>
            <dd className={`nums font-semibold ${status === 'expired' ? 'text-bad' : ''}`} data-testid="badge-expires">{fmt(badge?.expiresAt)}</dd>
          </div>
        </dl>
        {qr && target ? (
          <a
            href={target}
            target="_blank"
            rel="noopener noreferrer"
            className="focusable shrink-0 rounded-md bg-white p-1.5"
            aria-label="Verify this badge"
            data-testid="badge-qr"
            data-target={target}
          >
            <svg viewBox={`0 0 ${qr.length} ${qr.length}`} width="84" height="84" shapeRendering="crispEdges" aria-hidden="true">
              <path d={qrPath(qr)} fill="#0B1220" />
            </svg>
          </a>
        ) : showQr ? (
          <p className="max-w-[46%] text-[12px] leading-snug text-ink-mute" data-testid="badge-qr-missing">
            The QR code appears once the badge is created. Scanning it shows a homeowner this badge is real.
          </p>
        ) : null}
      </div>
    </div>
  )
}
