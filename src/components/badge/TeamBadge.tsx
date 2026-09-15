import { useMemo } from 'react'
import { qrModules, qrPath } from '../../lib/qr'
import { verifyUrl } from '../../lib/badge'
import type { BadgeInfo } from '../../types'

/**
 * The team member badge as a homeowner sees it held up at the door.
 *
 * One rendering for every place it appears — the onboarding step, My badge in
 * More, the company page in the console, the public verification page — so the
 * badge a rep confirmed is the badge everyone else looks at. Nothing here is
 * fetched: the parent hands in what the server said, and the component draws
 * it. That is what makes it honest offline and what keeps "viewing the badge"
 * from ever minting one.
 *
 * The design is a company-issued ID card, portrait: a blue header with the
 * lanyard slot and TEAM MEMBER, the company's logo (or its name, set as type,
 * when there is no logo), the person's photo large enough to recognise them
 * from a porch, their name in capitals with their title under it, and along
 * the bottom the id, the issue and expiry dates on the left and the QR code on
 * the right. White in both themes, because a badge is a card and not chrome.
 *
 * The QR code opens this badge's public verification page — the homeowner's
 * real question is "is this person who they say they are", and that page
 * answers it with the name, the photo, the company and whether the badge is
 * still good. There is no code until there is a badge, because there is
 * nothing to verify. A badge with no photo shows where the photo goes rather
 * than initials: initials on an ID card are a card with no face on it, and the
 * step that shows this will not let it be confirmed that way.
 */
export interface TeamBadgeProps {
  badge: BadgeInfo | null
  name: string
  title: string
  company: { name: string; timezone?: string; logoUrl?: string; website?: string; badgeQrUrl?: string }
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
  /*
    What the code encodes. The company's own QR link when the admin set one —
    the code the company already runs, with its own destination and its own
    scan counts — and the badge's verification page otherwise, so a badge is
    scannable before anyone has set anything.
  */
  const companyQr = company.badgeQrUrl?.trim() || undefined
  const target = badge ? companyQr ?? verifyUrl(badge.id) : undefined
  const targetKind: 'company' | 'verify' | undefined = target ? (companyQr ? 'company' : 'verify') : undefined
  const qr = useMemo(() => (target && showQr ? qrModules(target) : null), [target, showQr])
  const status = badge?.status ?? 'none'
  const tz = company.timezone
  const fmt = (ms?: number) =>
    ms ? new Date(ms).toLocaleDateString('en-US', { month: '2-digit', day: '2-digit', year: 'numeric', timeZone: tz }) : '—'

  return (
    <div
      className={`badge-paper mx-auto w-full max-w-[360px] overflow-hidden rounded-[22px] shadow-card ring-1 ring-black/10 ${className}`}
      data-testid="team-badge"
      data-status={status}
      role="group"
      aria-label={`Team member badge for ${name || 'you'}`}
    >
      {/* --- the header: slot and TEAM MEMBER ---------------------------- */}
      <div className="badge-blue px-5 pb-5 pt-3 text-center">
        <span aria-hidden className="mx-auto block h-[11px] w-[92px] rounded-full bg-white/90" />
        <p className="mt-4 text-[30px] font-black uppercase leading-none tracking-[-0.01em]" data-testid="badge-kind">
          Team member
        </p>
      </div>

      {/* --- the company --------------------------------------------------- */}
      <div className="flex min-h-[76px] items-center justify-center px-6 pt-5">
        {company.logoUrl ? (
          <>
            <img src={company.logoUrl} alt="" className="max-h-14 max-w-[220px] object-contain" data-testid="badge-logo" />
            <p className="sr-only" data-testid="badge-company">{company.name}</p>
          </>
        ) : (
          <p
            className="text-center text-[22px] font-black uppercase leading-tight tracking-[0.02em] text-[#0b1220]"
            data-testid="badge-lockup"
          >
            <span data-testid="badge-company">{company.name || 'Your company'}</span>
          </p>
        )}
      </div>

      {/* --- the person ---------------------------------------------------- */}
      <div className="px-6 pt-5">
        {avatarUrl ? (
          <img
            src={avatarUrl}
            alt=""
            className="mx-auto block aspect-[4/5] w-full max-w-[280px] rounded-[18px] object-cover"
            data-testid="badge-photo"
            data-state="present"
          />
        ) : (
          <div
            className="mx-auto grid aspect-[4/5] w-full max-w-[280px] place-items-center rounded-[18px] bg-[#e9edf3] text-center"
            data-testid="badge-photo"
            data-state="missing"
          >
            <div>
              <span aria-hidden className="mx-auto grid h-16 w-16 place-items-center rounded-full bg-white text-[22px] font-semibold text-[#5a697d]">
                {avatarInitials}
              </span>
              <p className="mt-3 text-[13px] font-medium text-[#5a697d]">Your photo goes here</p>
            </div>
          </div>
        )}
      </div>

      <div className="px-6 pt-5">
        <p className="badge-blue-ink text-[26px] font-black uppercase leading-none tracking-[-0.01em]" data-testid="badge-name">
          {name || 'Your name'}
        </p>
        <p className="mt-1.5 text-[13px] font-bold uppercase tracking-[0.04em] text-[#0b1220]" data-testid="badge-title">
          {title}
        </p>
      </div>

      {/* --- id, dates, and the code ---------------------------------------- */}
      <div className="mt-3 flex items-end justify-between gap-4 border-t border-black/10 px-6 pb-6 pt-4">
        <dl className="grid gap-1.5 text-[14px]">
          <div className="flex items-baseline gap-3">
            <dt className="badge-blue-ink w-[68px] shrink-0 font-black uppercase tracking-[0.02em]">ID:</dt>
            <dd className="nums font-bold" data-testid="badge-id">
              {badge ? `#${badge.id}` : minting ? 'Creating…' : 'No badge yet'}
            </dd>
          </div>
          <div className="flex items-baseline gap-3">
            <dt className="badge-blue-ink w-[68px] shrink-0 font-black uppercase tracking-[0.02em]">Issued:</dt>
            <dd className="nums font-bold" data-testid="badge-issued">{fmt(badge?.issuedAt)}</dd>
          </div>
          <div className="flex items-baseline gap-3">
            <dt className="badge-blue-ink w-[68px] shrink-0 font-black uppercase tracking-[0.02em]">Expires:</dt>
            <dd className={`nums font-bold ${status === 'expired' ? 'text-[#b91c1c]' : ''}`} data-testid="badge-expires">
              {fmt(badge?.expiresAt)}
            </dd>
          </div>
          <div className="pt-1">
            <span
              className={`inline-block rounded-full px-2 py-0.5 text-[11px] font-semibold ${
                status === 'active'
                  ? 'bg-[#dcfce7] text-[#137536]'
                  : status === 'expired'
                    ? 'bg-[#fee2e2] text-[#b91c1c]'
                    : 'bg-[#fef3c7] text-[#92400e]'
              }`}
              data-testid="badge-status"
            >
              {BADGE_STATUS_LABEL[status]}
            </span>
          </div>
        </dl>
        {qr && target ? (
          <a
            href={target}
            target="_blank"
            rel="noopener noreferrer"
            className="focusable shrink-0 rounded-md bg-white p-1"
            aria-label={targetKind === 'company' ? `Open ${company.name}’s link` : 'Verify this badge'}
            data-testid="badge-qr"
            data-target={target}
            data-target-kind={targetKind}
          >
            <svg viewBox={`0 0 ${qr.length} ${qr.length}`} width="104" height="104" shapeRendering="crispEdges" aria-hidden="true">
              <path d={qrPath(qr)} fill="#0B1220" />
            </svg>
          </a>
        ) : showQr ? (
          <p className="max-w-[44%] text-[12px] leading-snug text-[#5a697d]" data-testid="badge-qr-missing">
            The QR code appears once the badge is created. Scanning it shows a homeowner this badge is real.
          </p>
        ) : null}
      </div>
    </div>
  )
}
