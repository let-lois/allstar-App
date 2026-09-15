import { useEffect, useState } from 'react'
import { Button } from '../components/ui/Button'
import {
  ApiError,
  apiDeleteUser,
  apiFootprint,
  apiRegenerateBadge,
  apiRenewBadge,
  apiResendInvite,
  apiResetLink,
  apiResetOnboarding,
  apiRevokeInvite,
  apiSetActive,
  apiSetPassword,
  apiSetRole,
  apiSetUserTeam,
  apiSetUserTitle,
  apiTeams,
  type FootprintDTO,
  type TeamDTO,
} from '../lib/http'
import { liveToken } from '../lib/session'
import { ROLE_BLURB, ROLE_LABEL, grantableRoles } from '../lib/roles'
import { useAppStore } from '../store/useAppStore'
import type { Role, TeamMember } from '../types'
import { BADGE_LABEL, INVITATION_LABEL, ONBOARDING_LABEL } from './statusLabels'

/**
 * Managing one person's account.
 *
 * The screen is built around a distinction the words hide. "Remove someone from
 * the team" and "delete their account" sound like the same request and are not:
 *
 *   Deactivate — they can't sign in, every session they hold dies immediately,
 *                and their work stays. This is what removing someone almost
 *                always means, so it's the prominent action.
 *   Delete     — the row goes, and every table keyed on it cascades: visits,
 *                notes, activity, tasks, routes, daily stats. That's not a
 *                login, it's the company's reporting history with a hole in it.
 *
 * So delete shows the real counts first and asks for the person's name to be
 * typed. Not friction for its own sake — the numbers are the informed half of
 * informed consent, and "are you sure?" isn't.
 */

export interface ManagedUser {
  id: string
  name: string
  email?: string
  role: Role
  active: boolean
  pending?: boolean
  jobTitle?: string
  teamId?: string
  teamName?: string
  invitation?: TeamMember['invitation']
  invitedAt?: number
  resentAt?: number
  openedAt?: number
  onboarding?: TeamMember['onboarding']
  onboardingStep?: TeamMember['onboardingStep']
  badge?: TeamMember['badge']
  badgeExpiresAt?: number
}

const MIN_PASSWORD = 10

/** `Sep 15, 2026` — a date an admin reads out over the phone, not a timestamp. */
const inviteDate = (ms: number) =>
  new Date(ms).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })



export function ManageUser({
  user,
  isSelf,
  onChanged,
  onRefresh,
  onClose,
}: {
  user: ManagedUser
  isSelf: boolean
  /** The change ends the conversation: refresh the roster and close. */
  onChanged: () => void
  /** The change is one of several: refresh the roster, keep the sheet open. */
  onRefresh?: () => void
  onClose: () => void
}) {
  const refresh = onRefresh ?? onChanged
  const [busy, setBusy] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [notice, setNotice] = useState<string | null>(null)

  const [password, setPassword] = useState('')
  const [reveal, setReveal] = useState(false)
  const [link, setLink] = useState<string | null>(null)
  const [copied, setCopied] = useState(false)

  const signedIn = useAppStore((s) => s.user)
  const roles = grantableRoles(signedIn)

  const [confirming, setConfirming] = useState(false)
  const [typed, setTyped] = useState('')
  const [foot, setFoot] = useState<FootprintDTO | null>(null)

  const [teams, setTeams] = useState<TeamDTO[] | null>(null)
  const [title, setTitle] = useState(user.jobTitle ?? '')
  const [inviteLink, setInviteLink] = useState<string | null>(null)
  const canInvite = signedIn?.role === 'client_admin' || signedIn?.role === 'super_admin'

  // The team picker needs the list; the rest of the panel does not wait for it.
  useEffect(() => {
    const token = liveToken()
    if (!token || !canInvite) return
    void apiTeams(token)
      .then((r) => setTeams(r.teams))
      .catch(() => setTeams([]))
  }, [canInvite])

  // Load the footprint as soon as delete is considered, not after it's
  // confirmed — the whole point is to inform the decision.
  useEffect(() => {
    if (!confirming) return
    const token = liveToken()
    if (!token) return
    void apiFootprint(token, user.id)
      .then(setFoot)
      .catch(() => setFoot(null))
  }, [confirming, user.id])

  /*
    `stay`: refresh the roster behind the sheet but leave it open. Setting a
    team, a title or re-sending a link are edits an admin makes two or three of
    in a row; closing after each would send them back to the table every time.
    Access and role changes still close — those end the conversation.
  */
  async function run(label: string, fn: (token: string) => Promise<void>, stay = false) {
    const token = liveToken()
    if (!token) {
      setError('This needs a live account. The demo has no real team.')
      return
    }
    setBusy(label)
    setError(null)
    setNotice(null)
    try {
      await fn(token)
      if (stay) refresh()
      else onChanged()
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'That didn’t work. Nothing was changed.')
    } finally {
      setBusy(null)
    }
  }

  const totalRecords = foot
    ? foot.visits + foot.notes + foot.photos + foot.tasks + foot.appointments + foot.activity
    : 0

  return (
    <div className="space-y-5 pt-1">
      {error && (
        <p role="alert" className="rounded-lg bg-bad-bg p-3 text-sm font-medium text-bad">
          {error}
        </p>
      )}
      {notice && (
        <p role="status" className="rounded-lg bg-good-bg p-3 text-sm font-medium text-good">
          {notice}
        </p>
      )}

      {/* --- invitation -------------------------------------------------- */}
      {!isSelf && canInvite && user.pending && (
        <section data-testid="manage-invitation">
          <h3 className="text-sm font-bold">Invitation</h3>
          <p className="mt-1 text-xs leading-relaxed text-ink-mute">
            {INVITATION_LABEL[user.invitation ?? 'not_sent']}
            {user.invitation === 'pending' && ' — they have a link that still works.'}
            {user.invitation === 'opened' && ' — they opened their link but have not set a password yet.'}
            {user.invitation === 'expired' && ' — their link has run out; send a fresh one.'}
            {user.invitation === 'revoked' && ' — their link was cancelled; send a fresh one if they should still join.'}
            {(!user.invitation || user.invitation === 'not_sent') && ' — no link has been made for them yet.'}
          </p>
          {/*
            When they were first asked, and when they were last chased. Two
            dates rather than one because "invited three weeks ago" and
            "invited three weeks ago, chased yesterday" call for different
            things from the person reading this, and the newest token alone
            cannot tell them apart.
          */}
          {user.invitedAt && (
            <p className="mt-1 text-xs text-ink-mute" data-testid="manage-invite-dates">
              Invited {inviteDate(user.invitedAt)}
              {user.resentAt ? ` · Resent ${inviteDate(user.resentAt)}` : ''}
              {user.openedAt ? ` · Opened ${inviteDate(user.openedAt)}` : ''}
            </p>
          )}
          <div className="mt-2 flex flex-wrap gap-2">
            <Button
              size="sm"
              disabled={busy !== null}
              onClick={() =>
                void run('resend', async (token) => {
                  const r = await apiResendInvite(token, user.id)
                  setInviteLink(r.url)
                  setNotice(r.emailed ? `A fresh invitation is in ${r.email}’s inbox. Their old link no longer works.` : `Fresh link made for ${r.email}. Nothing was emailed — ${r.mailError ?? 'email is not set up on this deployment'}; send it yourself.`)
                }, true)
              }
            >
              {busy === 'resend' ? 'Sending…' : user.invitation === 'pending' || user.invitation === 'opened' ? 'Re-send invite' : 'Send invite'}
            </Button>
            {(user.invitation === 'pending' || user.invitation === 'opened') && (
              <Button
                size="sm"
                variant="secondary"
                disabled={busy !== null}
                onClick={() =>
                  void run('revoke', async (token) => {
                    await apiRevokeInvite(token, user.id)
                    setInviteLink(null)
                    setNotice(`${user.name}’s invite link no longer works. Their account stays here, without access, until you send another or remove them.`)
                  }, true)
                }
              >
                {busy === 'revoke' ? 'Revoking…' : 'Revoke invite'}
              </Button>
            )}
          </div>
          {inviteLink && (
            <div className="mt-3 rounded-lg bg-surface-sunk p-3 ring-1 ring-line">
              <p className="break-all font-mono text-xs" data-testid="manage-invite-link">{inviteLink}</p>
              <Button
                size="sm"
                variant="secondary"
                className="mt-2"
                onClick={async () => {
                  try {
                    await navigator.clipboard.writeText(inviteLink)
                    setCopied(true)
                    setTimeout(() => setCopied(false), 2000)
                  } catch {
                    /* the link is on screen and selectable */
                  }
                }}
              >
                {copied ? 'Copied' : 'Copy link'}
              </Button>
            </div>
          )}
        </section>
      )}

      {/* --- team and title ---------------------------------------------- */}
      {canInvite && (
        <section className={!isSelf && user.pending ? 'border-t border-line-soft pt-4' : ''} data-testid="manage-team">
          <h3 className="text-sm font-bold">Team and title</h3>
          <p className="mt-1 text-xs leading-relaxed text-ink-mute">
            Both print on the badge and the roster. A person can change their own title; only an admin moves them between teams.
          </p>
          <label className="mt-2 block">
            <span className="text-xs font-semibold text-ink-mute">Team / office</span>
            <select
              value={user.teamId ?? ''}
              disabled={busy !== null || teams === null}
              data-testid="manage-team-select"
              onChange={(e) =>
                void run('team', async (token) => {
                  const next = e.target.value || null
                  await apiSetUserTeam(token, user.id, next)
                  const name = teams?.find((t) => t.id === next)?.name
                  setNotice(next ? `${user.name} is now on ${name ?? 'that team'}.` : `${user.name} is on no team.`)
                }, true)
              }
              className="focusable mt-1 h-11 w-full rounded-lg border border-ink/15 bg-surface px-3 text-sm disabled:opacity-60"
            >
              <option value="">No team</option>
              {(teams ?? []).map((t) => (
                <option key={t.id} value={t.id}>
                  {t.name}
                </option>
              ))}
            </select>
          </label>
          {teams !== null && teams.length === 0 && (
            <p className="mt-1 text-xs text-ink-mute">No teams yet — add them under Settings, on the Company tab.</p>
          )}
          <div className="mt-3 flex gap-2">
            <input
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              placeholder="Job title, as printed on the badge"
              autoCapitalize="words"
              data-testid="manage-title"
              className="focusable h-11 flex-1 rounded-lg border border-ink/15 px-3 text-sm"
            />
            <Button
              variant="secondary"
              disabled={busy !== null || title.trim() === (user.jobTitle ?? '')}
              data-testid="manage-title-save"
              onClick={() =>
                void run('title', async (token) => {
                  await apiSetUserTitle(token, user.id, title.trim())
                  setNotice(title.trim() ? `${user.name}’s title is now “${title.trim()}”.` : `${user.name}’s title was cleared.`)
                }, true)
              }
            >
              {busy === 'title' ? 'Saving…' : 'Save title'}
            </Button>
          </div>
        </section>
      )}

      {/* --- onboarding -------------------------------------------------- */}
      {!isSelf && canInvite && !user.pending && user.onboarding && (
        <section className="border-t border-line-soft pt-4" data-testid="manage-onboarding">
          <h3 className="text-sm font-bold">Onboarding</h3>
          <p className="mt-1 text-xs leading-relaxed text-ink-mute">
            {ONBOARDING_LABEL[user.onboarding]}
            {user.onboarding !== 'complete' && user.onboardingStep ? `, at the ${user.onboardingStep} step.` : '.'}{' '}
            Resetting signs {user.name.split(' ')[0]} out and opens the flow again on their next sign-in. What they entered stays — it asks
            them to check it, not to type it again.
          </p>
          <Button
            size="sm"
            variant="secondary"
            className="mt-2"
            disabled={busy !== null}
            data-testid="manage-onboarding-reset"
            onClick={() =>
              void run('onboarding', async (token) => {
                await apiResetOnboarding(token, user.id)
                setNotice(`${user.name} will go through setup again the next time they open the app.`)
              }, true)
            }
          >
            {busy === 'onboarding' ? 'Resetting…' : 'Reset onboarding'}
          </Button>
        </section>
      )}

      {/* --- badge ------------------------------------------------------- */}
      {canInvite && !user.pending && user.badge && user.badge !== 'none' && (
        <section className="border-t border-line-soft pt-4" data-testid="manage-badge">
          <h3 className="text-sm font-bold">Badge</h3>
          <p className="mt-1 text-xs leading-relaxed text-ink-mute">
            {BADGE_LABEL[user.badge]}
            {user.badgeExpiresAt ? `, ${user.badge === 'expired' ? 'expired' : 'expires'} ${new Date(user.badgeExpiresAt).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })}.` : '.'}{' '}
            Renew keeps the id and sets a new expiry. Regenerate gives a different id — for a badge that was lost or copied. Either way they
            confirm it again on their phone.
          </p>
          <div className="mt-2 flex flex-wrap gap-2">
            <Button
              size="sm"
              variant="secondary"
              disabled={busy !== null}
              data-testid="manage-badge-renew"
              onClick={() =>
                void run('badge-renew', async (token) => {
                  const r = await apiRenewBadge(token, user.id)
                  setNotice(`Badge #${r.badge.id} renewed. ${user.name.split(' ')[0]} confirms it again on their phone.`)
                }, true)
              }
            >
              {busy === 'badge-renew' ? 'Renewing…' : 'Renew badge'}
            </Button>
            <Button
              size="sm"
              variant="secondary"
              disabled={busy !== null}
              data-testid="manage-badge-regenerate"
              onClick={() =>
                void run('badge-regenerate', async (token) => {
                  const r = await apiRegenerateBadge(token, user.id)
                  setNotice(`New badge #${r.badge.id} issued. The old id no longer belongs to anyone.`)
                }, true)
              }
            >
              {busy === 'badge-regenerate' ? 'Issuing…' : 'Regenerate id'}
            </Button>
          </div>
        </section>
      )}

      {/* --- password ---------------------------------------------------- */}
      <section className={canInvite ? 'border-t border-line-soft pt-4' : ''}>
        <h3 className="text-sm font-bold">Password</h3>
        <p className="mt-1 text-xs leading-relaxed text-ink-mute">
          Setting one here signs {isSelf ? 'you' : user.name.split(' ')[0]} out of every
          device immediately — which is the point when a phone goes missing.
          {!isSelf && ' You will know this password, so send a link instead if that matters.'}
          {isSelf && ' You will have to sign in again with the new one.'}
        </p>

        <div className="mt-3 flex gap-2">
          <span className="relative flex-1">
            <input
              type={reveal ? 'text' : 'password'}
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              autoComplete="new-password"
              placeholder={`At least ${MIN_PASSWORD} characters`}
              className="focusable h-11 w-full rounded-lg border border-ink/15 pl-3 pr-16 text-sm"
            />
            <button
              type="button"
              onClick={() => setReveal((v) => !v)}
              aria-pressed={reveal}
              className="focusable absolute right-1 top-1 h-9 rounded px-2 text-xs font-bold uppercase tracking-wide text-ink-mute"
            >
              {reveal ? 'Hide' : 'Show'}
            </button>
          </span>
          <Button
            disabled={busy !== null || password.length < MIN_PASSWORD}
            onClick={() =>
              void run('password', async (token) => {
                await apiSetPassword(token, user.id, password)
                setPassword('')
                setNotice(
                  isSelf
                    ? 'Password changed. You’ll be signed out — use the new one.'
                    : `Password set. ${user.name} is signed out of every device.`,
                )
              })
            }
          >
            {busy === 'password' ? 'Saving…' : 'Set'}
          </Button>
        </div>

        <div className="mt-3 border-t border-line-soft pt-3">
          <Button
            variant="secondary"
            disabled={busy !== null}
            onClick={() =>
              void run('link', async (token) => {
                const res = await apiResetLink(token, user.id)
                setLink(res.url)
                setNotice('Link created. Nothing was emailed — send it yourself.')
              })
            }
          >
            {busy === 'link' ? 'Creating…' : 'Create a reset link instead'}
          </Button>
          <p className="mt-1.5 text-xs text-ink-mute">
            They choose their own password and you never see it. Expires in two days.
          </p>

          {link && (
            <div className="mt-3 rounded-lg bg-surface-sunk p-3 ring-1 ring-line">
              <p className="break-all font-mono text-xs">{link}</p>
              <Button
                size="sm"
                variant="secondary"
                className="mt-2"
                onClick={async () => {
                  try {
                    await navigator.clipboard.writeText(link)
                    setCopied(true)
                    setTimeout(() => setCopied(false), 2000)
                  } catch {
                    /* the link is on screen and selectable */
                  }
                }}
              >
                {copied ? 'Copied' : 'Copy link'}
              </Button>
            </div>
          )}
        </div>
      </section>

      {/* --- role -------------------------------------------------------- */}
      {!isSelf && (
        <section className="border-t border-line-soft pt-4">
          <h3 className="text-sm font-bold">Role</h3>
          <p className="mt-1 text-xs leading-relaxed text-ink-mute">
            Changing it signs {user.name.split(' ')[0]} out, so a demotion takes effect on
            the phone in their hand rather than whenever they next sign out.
          </p>
          <select
            value={user.role}
            disabled={busy !== null}
            onChange={(e) =>
              void run('role', async (token) => {
                const next = e.target.value as ManagedUser['role']
                await apiSetRole(token, user.id, next)
                setNotice(`${user.name} is now a ${ROLE_LABEL[next]}.`)
              })
            }
            className="focusable mt-2 h-11 w-full rounded-lg border border-ink/15 bg-surface px-3 text-sm disabled:opacity-60"
          >
            {/* The role they already hold is always listed, even if this admin
                could not grant it — otherwise the dropdown would silently show
                the wrong current value. */}
            {[...new Set([user.role, ...roles])].map((r) => (
              <option key={r} value={r} disabled={!roles.includes(r)}>
                {ROLE_LABEL[r]} — {ROLE_BLURB[r]}
              </option>
            ))}
          </select>
        </section>
      )}

      {/* --- access ------------------------------------------------------ */}
      {!isSelf && (
        <section className="border-t border-line-soft pt-4">
          <h3 className="text-sm font-bold">Access</h3>
          {user.pending && user.active && (
            <p className="mt-1 rounded-lg bg-warn-bg p-2.5 text-xs leading-relaxed text-warn">
              {user.name} hasn’t opened their invite yet, so they have no password.
              Setting one above works and switches their account on; their old
              invite link then stops working, so tell them the password yourself.
            </p>
          )}
          {user.active ? (
            <>
              <p className="mt-1 text-xs leading-relaxed text-ink-mute">
                Switching {user.name.split(' ')[0]} off ends their sessions now and blocks
                sign-in. Their visits, notes and numbers stay, so your reporting history
                stays intact. This is what you want for someone who has left.
              </p>
              <Button
                variant="secondary"
                className="mt-2"
                disabled={busy !== null}
                onClick={() =>
                  void run('deactivate', async (token) => {
                    await apiSetActive(token, user.id, false)
                    setNotice(`${user.name} can no longer sign in. Their work is untouched.`)
                  })
                }
              >
                {busy === 'deactivate' ? 'Saving…' : 'Remove from team'}
              </Button>
            </>
          ) : (
            <>
              <p className="mt-1 text-xs leading-relaxed text-ink-mute">
                {user.name} can’t sign in. Turning access back on restores it — they keep
                the password they had.
              </p>
              <Button
                className="mt-2"
                disabled={busy !== null}
                onClick={() =>
                  void run('activate', async (token) => {
                    await apiSetActive(token, user.id, true)
                    setNotice(`${user.name} can sign in again.`)
                  })
                }
              >
                {busy === 'activate' ? 'Saving…' : 'Restore access'}
              </Button>
            </>
          )}
        </section>
      )}

      {/* --- delete ------------------------------------------------------ */}
      {!isSelf && (
        <section className="border-t border-line-soft pt-4">
          <h3 className="text-sm font-bold text-bad">Delete permanently</h3>

          {!confirming ? (
            <>
              <p className="mt-1 text-xs leading-relaxed text-ink-mute">
                Erases the account and everything recorded against it. Almost always the
                wrong choice — “Remove from team” above does what people usually mean.
              </p>
              <Button
                variant="secondary"
                className="mt-2 text-bad"
                onClick={() => setConfirming(true)}
              >
                Delete {user.name}…
              </Button>
            </>
          ) : (
            <div className="mt-2 rounded-field bg-bad-bg p-3 ring-1 ring-bad/25">
              <p className="text-sm font-semibold text-bad">
                This deletes {totalRecords.toLocaleString()} record
                {totalRecords === 1 ? '' : 's'} and cannot be undone.
              </p>

              {foot ? (
                <ul className="mt-2 grid grid-cols-2 gap-x-4 text-xs text-bad">
                  <Count label="visits" n={foot.visits} />
                  <Count label="notes" n={foot.notes} />
                  <Count label="photos" n={foot.photos} />
                  <Count label="tasks" n={foot.tasks} />
                  <Count label="appointments" n={foot.appointments} />
                  <Count label="activity entries" n={foot.activity} />
                </ul>
              ) : (
                <p className="mt-2 text-xs text-bad">Counting what would be lost…</p>
              )}

              <p className="mt-2 text-xs text-bad">
                {foot?.assignedProperties
                  ? `Their ${foot.assignedProperties.toLocaleString()} assigned lead${
                      foot.assignedProperties === 1 ? '' : 's'
                    } will survive and return to Unassigned.`
                  : 'No leads are assigned to them.'}{' '}
                Their doors-per-day history disappears from every report.
              </p>

              <label className="mt-3 block">
                <span className="text-xs font-semibold text-bad">
                  Type “{user.name}” to confirm
                </span>
                <input
                  value={typed}
                  onChange={(e) => setTyped(e.target.value)}
                  className="focusable mt-1 h-10 w-full rounded-lg border border-bad/25 px-3 text-sm"
                />
              </label>

              <div className="mt-3 flex gap-2">
                <Button
                  variant="secondary"
                  className="text-bad"
                  disabled={typed.trim() !== user.name || busy !== null}
                  onClick={() =>
                    void run('delete', async (token) => {
                      await apiDeleteUser(token, user.id)
                      onClose()
                    })
                  }
                >
                  {busy === 'delete' ? 'Deleting…' : 'Delete permanently'}
                </Button>
                <Button
                  variant="secondary"
                  onClick={() => {
                    setConfirming(false)
                    setTyped('')
                  }}
                >
                  Cancel
                </Button>
              </div>
            </div>
          )}
        </section>
      )}

      {isSelf && (
        <p className="border-t border-line-soft pt-4 text-xs text-ink-mute">
          You can’t remove or delete your own account — that’s how a company locks
          itself out. Ask another administrator.
        </p>
      )}
    </div>
  )
}

function Count({ label, n }: { label: string; n: number }) {
  return (
    <li className="flex justify-between border-b border-line-soft py-0.5">
      <span>{label}</span>
      <span className="nums font-semibold">{n.toLocaleString()}</span>
    </li>
  )
}
