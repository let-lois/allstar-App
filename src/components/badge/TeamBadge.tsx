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
 * ## It is a CR80 card, at every size
 *
 * The card is the plastic one every ID printer and lanyard sleeve is made
 * for: 3.375 by 2.125 inches, portrait. The component keeps that ratio
 * exactly, and everything on it is sized in container-query units — a
 * percentage of the card's own width — so the phone's preview, the console's
 * thumbnail and the file `lib/badge-image.ts` draws are the same card at
 * different sizes rather than three layouts that happen to share a logo.
 * Nothing on it is sized in pixels, which is what stops a narrow screen from
 * pushing the code off the bottom or a wide one from leaving it tiny.
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

/**
 * The CR80 ratio, portrait. The same constant `lib/badge-image.ts` renders
 * the file at, so the preview cannot drift from the download.
 */
export const BADGE_ASPECT = '2.125 / 3.375'

/** What the code encodes, given what the parent knows — shared with the file. */
export function badgeTarget(
  badge: BadgeInfo | null,
  company: { name: string; badgeQrUrl?: string },
): { target: string; kind: 'company' | 'verify' } | null {
  if (!badge) return null
  const companyQr = company.badgeQrUrl?.trim() || undefined
  return companyQr ? { target: companyQr, kind: 'company' } : { target: verifyUrl(badge.id), kind: 'verify' }
}

/* A length as a fraction of the card's width. 100cqw is the whole card. */
const w = (fraction: number) => `${fraction}cqw`

/*
  The card's vertical plan, in card widths (the card is 158.8 tall).

  The code used to be pinned to the bottom-right corner at 40 wide, which put
  its top edge at 112.8 — across the name (109–117) and the title (118–124),
  which ran the full width underneath it. A long name simply went under the
  code. Now each band has its own height and the code starts below the rule:

      photo      49.9 – 95.8
      name       97.6 – 105.6   one line, sized to fit
      title     106.9 – 111.9   one line, sized to fit
      rule      113.2
      details   116.5 –         left column
      code      117.0 – 155.0   right column, 38 wide (0.81 in printed)

  `lib/badge-image.ts` draws the file to the same plan in inches.
*/
const TEXT_WIDTH = 81 // the card less its 9.4 margins, in cqw, with a hair spare
let measurer: CanvasRenderingContext2D | null | undefined

/**
 * The largest font, in cqw, at which `text` fits the badge's width on one
 * line — between `max` and `min`. Past the minimum the line is truncated with
 * an ellipsis, and the full text stays in the element's title and label.
 *
 * Measured, not guessed from a character count: "WILLIAM" and "IIIIIII" are
 * very different widths, and a name is exactly where that shows.
 */
function fitCqw(text: string, weight: number, max: number, min: number, trackingEm = 0): number {
  if (!text) return max
  if (measurer === undefined) measurer = typeof document !== 'undefined' ? document.createElement('canvas').getContext('2d') : null
  if (!measurer) return max
  const family = getComputedStyle(document.body).fontFamily || 'sans-serif'
  measurer.font = `${weight} 100px ${family}`
  // Width at a 1cqw font, in cqw: the glyphs, plus the tracking per character.
  const perUnit = measurer.measureText(text).width / 100 + text.length * trackingEm
  if (perUnit <= 0) return max
  return Math.max(min, Math.min(max, TEXT_WIDTH / perUnit))
}

export function TeamBadge({ badge, name, title, company, avatarUrl, avatarInitials, minting = false, showQr = true, className = '' }: TeamBadgeProps) {
  /*
    What the code encodes. The company's own QR link when the admin set one —
    the code the company already runs, with its own destination and its own
    scan counts — and the badge's verification page otherwise, so a badge is
    scannable before anyone has set anything.
  */
  const aim = badgeTarget(badge, company)
  const target = aim?.target
  const targetKind = aim?.kind
  const qr = useMemo(() => (target && showQr ? qrModules(target) : null), [target, showQr])
  const status = badge?.status ?? 'none'
  const tz = company.timezone
  const shownName = name || 'Your name'
  // Sized to the one line each has; see the plan above `fitCqw`.
  const nameSize = useMemo(() => fitCqw(shownName.toUpperCase(), 900, 8, 4.6, -0.01), [shownName])
  const titleSize = useMemo(() => fitCqw((title || '').toUpperCase(), 700, 4, 3, 0.04), [title])
  const fmt = (ms?: number) =>
    ms ? new Date(ms).toLocaleDateString('en-US', { month: '2-digit', day: '2-digit', year: 'numeric', timeZone: tz }) : '—'

  return (
    /*
      The frame is the container the card measures itself against, and it is
      a separate element on purpose: a container's own units resolve against
      its parent, so the card's radius and everything inside it need the
      frame outside them to read.
    */
    <div className={`mx-auto w-full max-w-[360px] ${className}`} style={{ containerType: 'inline-size' }}>
      <div
        className="badge-paper relative overflow-hidden shadow-card ring-1 ring-black/10"
        style={{ aspectRatio: BADGE_ASPECT, borderRadius: w(5.9) }}
        data-testid="team-badge"
        data-status={status}
        role="group"
        aria-label={`Team member badge for ${name || 'you'}`}
      >
        {/* --- the header: slot and TEAM MEMBER ---------------------------- */}
        <div className="badge-blue absolute inset-x-0 top-0 text-center" style={{ height: w(29.2) }}>
          <span
            aria-hidden
            className="absolute left-1/2 block -translate-x-1/2 rounded-full bg-white/90"
            style={{ top: w(4.7), width: w(26), height: w(3.5) }}
          />
          <p
            className="absolute inset-x-0 font-black uppercase leading-none tracking-[-0.01em]"
            style={{ top: w(13.5), fontSize: w(8.9) }}
            data-testid="badge-kind"
          >
            Team member
          </p>
        </div>

        {/* --- the company --------------------------------------------------- */}
        <div
          className="absolute inset-x-0 flex items-center justify-center"
          style={{ top: w(31.5), height: w(17), paddingLeft: w(8), paddingRight: w(8) }}
        >
          {company.logoUrl ? (
            <>
              <img
                src={company.logoUrl}
                alt=""
                className="object-contain"
                style={{ maxHeight: w(16), maxWidth: w(70) }}
                data-testid="badge-logo"
              />
              <p className="sr-only" data-testid="badge-company">{company.name}</p>
            </>
          ) : (
            <p
              className="text-center font-black uppercase leading-tight tracking-[0.02em] text-[#0b1220]"
              style={{ fontSize: w(7) }}
              data-testid="badge-lockup"
            >
              <span data-testid="badge-company">{company.name || 'Your company'}</span>
            </p>
          )}
        </div>

        {/* --- the person: a 4:5 portrait, or where it goes ---------------- */}
        {avatarUrl ? (
          <img
            src={avatarUrl}
            alt=""
            className="absolute left-1/2 aspect-[4/5] -translate-x-1/2 object-cover"
            style={{ top: w(49.9), width: w(36.7), borderRadius: w(2.6) }}
            data-testid="badge-photo"
            data-state="present"
          />
        ) : (
          <div
            className="absolute left-1/2 grid aspect-[4/5] -translate-x-1/2 place-items-center bg-[#e9edf3] text-center"
            style={{ top: w(49.9), width: w(36.7), borderRadius: w(2.6) }}
            data-testid="badge-photo"
            data-state="missing"
          >
            <div>
              {/* A true circle: equal sides, half-width radius, and nothing stretching the box. */}
              <span
                aria-hidden
                className="mx-auto grid place-items-center rounded-full bg-white font-semibold text-[#5a697d]"
                style={{ width: w(13.5), height: w(13.5), fontSize: w(5.4) }}
                data-testid="badge-initials"
              >
                {avatarInitials}
              </span>
              <p className="font-medium text-[#5a697d]" style={{ marginTop: w(2.2), fontSize: w(3.2) }}>
                Your photo goes here
              </p>
            </div>
          </div>
        )}

        {/* --- name and title ------------------------------------------------- */}
        <div className="absolute inset-x-0" style={{ top: w(97.6), paddingLeft: w(9.4), paddingRight: w(9.4) }}>
          <p
            className="badge-blue-ink overflow-hidden text-ellipsis whitespace-nowrap font-black uppercase tracking-[-0.01em]"
            style={{ fontSize: w(nameSize), lineHeight: w(8), height: w(8) }}
            title={shownName}
            data-testid="badge-name"
            data-font-cqw={nameSize.toFixed(2)}
          >
            {shownName}
          </p>
          <p
            className="overflow-hidden text-ellipsis whitespace-nowrap font-bold uppercase tracking-[0.04em] text-[#0b1220]"
            style={{ marginTop: w(1.3), fontSize: w(titleSize), lineHeight: w(5), height: w(5) }}
            title={title}
            data-testid="badge-title"
            data-font-cqw={titleSize.toFixed(2)}
          >
            {title}
          </p>
        </div>

        {/* --- id, dates, and the code ---------------------------------------- */}
        <div
          className="absolute inset-x-0 border-t border-black/10"
          style={{ top: w(113.2), left: w(9.4), right: w(9.4) }}
          data-testid="badge-rule"
        />
        <dl className="absolute grid" style={{ top: w(116.5), left: w(9.4), gap: w(1.4), fontSize: w(3.6) }} data-testid="badge-details">
          <div className="flex items-baseline" style={{ gap: w(2) }}>
            <dt className="badge-blue-ink shrink-0 font-black uppercase tracking-[0.02em]" style={{ width: w(19) }}>ID:</dt>
            <dd className="nums font-bold" data-testid="badge-id">
              {badge ? `#${badge.id}` : minting ? 'Creating…' : 'No badge yet'}
            </dd>
          </div>
          <div className="flex items-baseline" style={{ gap: w(2) }}>
            <dt className="badge-blue-ink shrink-0 font-black uppercase tracking-[0.02em]" style={{ width: w(19) }}>Issued:</dt>
            <dd className="nums font-bold" data-testid="badge-issued">{fmt(badge?.issuedAt)}</dd>
          </div>
          <div className="flex items-baseline" style={{ gap: w(2) }}>
            <dt className="badge-blue-ink shrink-0 font-black uppercase tracking-[0.02em]" style={{ width: w(19) }}>Expires:</dt>
            <dd className={`nums font-bold ${status === 'expired' ? 'text-[#b91c1c]' : ''}`} data-testid="badge-expires">
              {fmt(badge?.expiresAt)}
            </dd>
          </div>
          <div style={{ paddingTop: w(0.8) }}>
            <span
              className={`inline-block rounded-full font-semibold ${
                status === 'active'
                  ? 'bg-[#dcfce7] text-[#137536]'
                  : status === 'expired'
                    ? 'bg-[#fee2e2] text-[#b91c1c]'
                    : 'bg-[#fef3c7] text-[#92400e]'
              }`}
              style={{ padding: `${w(0.6)} ${w(2.2)}`, fontSize: w(3) }}
              data-testid="badge-status"
            >
              {BADGE_STATUS_LABEL[status]}
            </span>
          </div>
        </dl>
        {/*
          The code, sized to the card: 38% of its width is 0.81 inches on a
          printed CR80, inside the three-quarters-to-one-inch band a phone
          camera locks onto at arm's length. The quiet zone is the white
          padding around it, and `crispEdges` keeps each cell a square.
        */}
        {qr && target ? (
          <a
            href={target}
            target="_blank"
            rel="noopener noreferrer"
            className="focusable absolute block bg-white"
            style={{ right: w(6), bottom: w(3.8), width: w(38), height: w(38), padding: w(3), borderRadius: w(1.5) }}
            aria-label={targetKind === 'company' ? `Open ${company.name}’s link` : 'Verify this badge'}
            data-testid="badge-qr"
            data-target={target}
            data-target-kind={targetKind}
          >
            <svg viewBox={`0 0 ${qr.length} ${qr.length}`} width="100%" height="100%" shapeRendering="crispEdges" aria-hidden="true">
              <path d={qrPath(qr)} fill="#0B1220" />
            </svg>
          </a>
        ) : showQr ? (
          <p
            className="absolute leading-snug text-[#5a697d]"
            style={{ right: w(6), bottom: w(6), width: w(38), fontSize: w(3.2) }}
            data-testid="badge-qr-missing"
          >
            The QR code appears once the badge is created. Scanning it shows a homeowner this badge is real.
          </p>
        ) : null}
      </div>
    </div>
  )
}
