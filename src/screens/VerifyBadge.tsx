import { useEffect, useState } from 'react'
import { TeamBadge } from '../components/badge/TeamBadge'
import { ApiError, apiVerifyBadge, type VerifyDTO } from '../lib/http'
import { badgeIdFromPath } from '../lib/badge'
import { SkeletonRows } from '../components/ui/Skeleton'

/**
 * The page a homeowner reaches by scanning a badge.
 *
 * No sign-in, no app chrome, no store: this renders for a stranger holding a
 * phone at their own front door, and it has one job — say whether the badge
 * they were just shown is real and still good, and show them the face and
 * name it belongs to so they can compare. Everything else on the phone is
 * behind a login; this is deliberately in front of it.
 *
 * Four honest answers, each in its own words: active, expired, not yet
 * activated, no longer with the company. And a fifth for a number that does
 * not exist, which says so plainly rather than rendering an empty badge.
 */
type State = { kind: 'loading' } | { kind: 'ok'; data: VerifyDTO } | { kind: 'unknown' } | { kind: 'limited' } | { kind: 'offline' }

const initialsOf = (name: string) =>
  name
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((w) => w[0]!.toUpperCase())
    .join('') || '?'

export function VerifyBadge() {
  const badgeId = badgeIdFromPath(window.location.pathname)
  const [state, setState] = useState<State>({ kind: 'loading' })

  useEffect(() => {
    if (!badgeId) {
      setState({ kind: 'unknown' })
      return
    }
    let alive = true
    void apiVerifyBadge(badgeId)
      .then((data) => alive && setState({ kind: 'ok', data }))
      .catch((err) => {
        if (!alive) return
        if (err instanceof ApiError && err.status === 404) setState({ kind: 'unknown' })
        else if (err instanceof ApiError && err.status === 429) setState({ kind: 'limited' })
        else setState({ kind: 'offline' })
      })
    return () => {
      alive = false
    }
  }, [badgeId])

  const verdict =
    state.kind === 'ok'
      ? {
          active: { tone: 'good', title: 'This badge is valid', body: 'The person below is a current team member. Check that the photo and name match who is at your door.' },
          expired: { tone: 'bad', title: 'This badge has expired', body: 'It belonged to a team member, but it is past its date. Ask them for a current one before going further.' },
          pending: { tone: 'warn', title: 'This badge is not active yet', body: 'It has been issued but the team member has not confirmed it. Treat it as unverified for now.' },
          inactive: { tone: 'bad', title: 'This badge is no longer valid', body: 'The person it was issued to is no longer with the company. Do not rely on it.' },
        }[state.data.status]
      : state.kind === 'unknown'
        ? { tone: 'bad', title: 'No badge with this number', body: 'Nothing was issued under it. If someone showed you this code, do not let them in on the strength of it.' }
        : state.kind === 'limited'
          ? { tone: 'warn', title: 'Too many checks from this phone', body: 'Wait a few minutes and scan again.' }
          : state.kind === 'offline'
            ? { tone: 'warn', title: 'Could not check right now', body: 'Your phone may be offline. Try again in a moment.' }
            : null

  const toneClass = (tone: string) => (tone === 'good' ? 'bg-good-bg text-good' : tone === 'bad' ? 'bg-bad-bg text-bad' : 'bg-warn-bg text-warn')

  return (
    <main className="min-h-[100dvh] bg-surface-sunk px-4 pb-10 pt-6" data-testid="verify-page" data-state={state.kind === 'ok' ? state.data.status : state.kind}>
      <div className="mx-auto max-w-[420px]">
        <p className="text-[11px] font-semibold uppercase tracking-[0.14em] text-ink-mute">Team member badge check</p>

        {verdict && (
          <div className={`mt-3 rounded-field px-4 py-3.5 ${toneClass(verdict.tone)}`} role="status" data-testid="verify-verdict">
            <p className="text-[17px] font-semibold leading-tight">{verdict.title}</p>
            <p className="mt-1 text-[13.5px] leading-snug opacity-90">{verdict.body}</p>
          </div>
        )}
        {state.kind === 'loading' && (
          <div className="mt-4 card p-5" data-testid="verify-loading">
            <SkeletonRows rows={2} label="Checking this badge…" />
          </div>
        )}

        {state.kind === 'ok' && (
          <div className="mt-4">
            <TeamBadge
              badge={{
                id: state.data.badge.id,
                status: state.data.status === 'pending' ? 'awaiting_confirmation' : state.data.status === 'inactive' ? 'expired' : state.data.status,
                issuedAt: state.data.badge.issuedAt,
                expiresAt: state.data.badge.expiresAt,
              }}
              name={state.data.person.name}
              title={state.data.person.title ?? 'Team member'}
              company={state.data.company}
              avatarUrl={state.data.person.photoUrl}
              avatarInitials={initialsOf(state.data.person.name)}
              showQr={false}
            />
            {state.data.company.website && (
              <a
                href={state.data.company.website}
                target="_blank"
                rel="noopener noreferrer"
                className="focusable mt-4 flex min-h-tap items-center justify-center rounded-field bg-surface px-4 text-[15px] font-semibold text-accent ring-1 ring-line"
                data-testid="verify-website"
              >
                Visit {state.data.company.name}
              </a>
            )}
          </div>
        )}

        <p className="mt-8 text-[12px] leading-relaxed text-ink-mute">
          Badges are issued to team members by their company through Allstar and expire yearly. A valid badge tells you the person is a
          current team member; it does not oblige you to anything. Badge number {badgeId ?? '—'}.
        </p>
      </div>
    </main>
  )
}
