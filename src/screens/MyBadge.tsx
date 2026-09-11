import { useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { TopBar } from '../components/nav/TopBar'
import { Button } from '../components/ui/Button'
import { TeamBadge } from '../components/badge/TeamBadge'
import { ApiError, apiConfirmBadge, apiMintBadge, apiRenewOwnBadge } from '../lib/http'
import { ROLE_LABEL } from '../lib/roles'
import { liveToken } from '../lib/session'
import { useAppStore } from '../store/useAppStore'

/**
 * My badge — the badge a rep carries, from More.
 *
 * Reading it costs nothing: the badge comes from the user the store already
 * holds, so this screen works with no signal and never mints by being opened.
 * Three states ask for a tap and each is a separate server act with its own
 * audit line: no badge yet (people who joined before badges existed) → Create;
 * created but not confirmed → Confirm; expired → Renew. Everything else is
 * the admin's — a rep cannot regenerate their own id, and the screen says who
 * to ask rather than offering a button that would be refused.
 */
export function MyBadge() {
  const nav = useNavigate()
  const user = useAppStore((s) => s.user)
  const mode = useAppStore((s) => s.mode)
  const refreshMe = useAppStore((s) => s.refreshMe)
  const [busy, setBusy] = useState<'mint' | 'confirm' | 'renew' | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [needsName, setNeedsName] = useState(false)

  async function act(kind: 'mint' | 'confirm' | 'renew') {
    const token = liveToken()
    if (!token) return
    setBusy(kind)
    setError(null)
    try {
      if (kind === 'mint') await apiMintBadge(token)
      if (kind === 'confirm') await apiConfirmBadge(token)
      if (kind === 'renew') await apiRenewOwnBadge(token)
      await refreshMe()
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not reach the server just now. Try again when you have signal.')
      if (err instanceof ApiError && err.status === 409 && kind === 'mint') setNeedsName(true)
    } finally {
      setBusy(null)
    }
  }

  if (!user) return null
  const badge = user.badge ?? null
  const status = badge?.status ?? 'none'
  const name = [user.firstName, user.lastName].filter(Boolean).join(' ') || user.name
  const title = user.jobTitle || ROLE_LABEL[user.role]
  const company = user.company ?? { name: user.clientName, timezone: undefined }

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <TopBar title="My badge" back="/more" />
      <div className="scroll-pane pad-nav bg-surface-sunk">
        <div className="content-col page anim-rise">
          {mode !== 'live' ? (
            <p className="text-[15px] leading-relaxed text-ink-mute" data-testid="badge-demo">
              Badges belong to a company account. Sign in to yours and your badge appears here.
            </p>
          ) : (
            <>
              <TeamBadge
                badge={badge}
                name={name}
                title={title}
                company={company}
                avatarUrl={user.avatarUrl}
                avatarInitials={user.avatarInitials}
              />

              {error && (
                <div className="mt-4 rounded-field bg-bad-bg px-3 py-2.5 text-[14px] font-medium text-bad" role="alert">
                  <p>{error}</p>
                  {needsName && (
                    <Button size="sm" variant="secondary" className="mt-2" onClick={() => nav('/profile')}>
                      Add your name
                    </Button>
                  )}
                </div>
              )}

              {status === 'none' && (
                <>
                  <p className="mt-5 text-[14px] leading-relaxed text-ink-mute">
                    You joined before badges existed. Create yours, check it, and confirm it — the id stays the same for as long as you are on the team.
                  </p>
                  <Button size="lg" full className="mt-4" disabled={busy !== null} onClick={() => void act('mint')} data-testid="badge-create">
                    {busy === 'mint' ? 'Creating…' : 'Create my badge'}
                  </Button>
                </>
              )}
              {status === 'awaiting_confirmation' && (
                <>
                  <p className="mt-5 text-[14px] leading-relaxed text-ink-mute">
                    Check every line. Confirming records that you did, with the time.
                  </p>
                  <Button size="lg" full className="mt-4" disabled={busy !== null} onClick={() => void act('confirm')} data-testid="badge-confirm">
                    {busy === 'confirm' ? 'Saving…' : 'Confirm badge information'}
                  </Button>
                </>
              )}
              {status === 'expired' && (
                <>
                  <p className="mt-5 text-[14px] leading-relaxed text-ink-mute" data-testid="badge-expired-copy">
                    This badge has expired. Renewing keeps your id and sets a new expiry; you confirm it again afterwards.
                  </p>
                  <Button size="lg" full className="mt-4" disabled={busy !== null} onClick={() => void act('renew')} data-testid="badge-renew">
                    {busy === 'renew' ? 'Renewing…' : 'Renew my badge'}
                  </Button>
                </>
              )}
              {status === 'active' && (
                <p className="mt-5 text-[14px] leading-relaxed text-ink-mute" data-testid="badge-active-copy">
                  Show this at the door. Homeowners can scan the code to reach the company’s website.
                </p>
              )}

              <p className="mt-6 text-[13px] leading-relaxed text-ink-mute">
                Name or title wrong?{' '}
                <button type="button" className="focusable inline-flex min-h-tap items-center font-semibold text-accent underline-offset-2 hover:underline" onClick={() => nav('/profile')} data-testid="badge-edit-profile">
                  Edit your profile
                </button>
                . A new id, or a change to your email, role or team, is your admin’s to make.
              </p>
            </>
          )}
        </div>
      </div>
    </div>
  )
}
