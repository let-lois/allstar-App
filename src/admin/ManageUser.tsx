import { useEffect, useState } from 'react'
import { describeError } from '../lib/errors'
import { Button } from '../components/ui/Button'
import { ConfirmDialog } from '../components/ui/ConfirmDialog'
import {
  apiDeleteUser,
  apiFootprint,
  apiRegenerateBadge,
  apiRenewBadge,
  apiResendInvite,
  apiResetOnboarding,
  apiRevokeInvite,
  apiSendResetEmail,
  apiSetActive,
  apiSetPassword,
  apiSetRole,
  apiSetUserEmail,
  apiSetUserName,
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
 *
 * Passwords follow one rule: an admin never knows anybody else's. For someone
 * else the only password action is a reset *email* — the link goes to their
 * inbox, they choose the password, and the console is told only where it went.
 * The one password typed on this sheet is your own.
 */

export interface ManagedUser {
  id: string
  name: string
  firstName?: string
  lastName?: string
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

/** The server's rule (api/src/users.ts `emailError`), checked here first so a typo is caught before a round trip. */
const EMAIL_SHAPE = /^[^\s@<>(),;:"]+@[^\s@<>(),;:"]+\.[^\s@<>(),;:".]{2,}$/
export function emailProblem(email: string, current?: string): string | null {
  if (!email) return 'Enter an email address.'
  if (email.length > 254) return 'That email address is too long.'
  if (!EMAIL_SHAPE.test(email)) return 'Enter a valid email address, like name@company.com.'
  if (current && email === current) return 'That is already their email.'
  return null
}

/** Where a section's own result is shown — next to the button that caused it, not at the top of a long sheet. */
type Said = { tone: 'good' | 'bad'; text: string } | null

function SectionMessage({ said, testId }: { said: Said; testId: string }) {
  if (!said) return null
  return (
    <p
      role={said.tone === 'bad' ? 'alert' : 'status'}
      data-testid={testId}
      className={`mt-2 rounded-lg p-2.5 text-xs font-medium leading-relaxed ${
        said.tone === 'bad' ? 'bg-bad-bg text-bad' : 'bg-good-bg text-good'
      }`}
    >
      {said.text}
    </p>
  )
}

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
  const [copied, setCopied] = useState(false)

  // Account details: name and sign-in email, each edited on its own.
  const [editingName, setEditingName] = useState(false)
  const [firstName, setFirstName] = useState(user.firstName ?? '')
  const [lastName, setLastName] = useState(user.lastName ?? '')
  const [editingEmail, setEditingEmail] = useState(false)
  const [email, setEmail] = useState(user.email ?? '')
  const [emailTouched, setEmailTouched] = useState(false)
  const [confirmEmail, setConfirmEmail] = useState(false)
  const [detailsSaid, setDetailsSaid] = useState<Said>(null)

  // The reset email: asked first, then sent once.
  const [confirmReset, setConfirmReset] = useState(false)
  const [resetSaid, setResetSaid] = useState<Said>(null)

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
      setError(describeError(err, 'That didn’t work. Nothing was changed.'))
    } finally {
      setBusy(null)
    }
  }

  /*
    The account-details and password actions report beside themselves rather
    than in the banner at the top: on a phone this sheet is several screens
    tall, and a result shown where nobody is looking is not shown. `busy` is the
    same lock `run` uses, so nothing else on the sheet starts while one of these
    is in flight — and a second tap on the same button does nothing.
  */
  async function act(label: string, say: (s: Said) => void, fn: (token: string) => Promise<string>): Promise<boolean> {
    const token = liveToken()
    if (!token) {
      say({ tone: 'bad', text: 'This needs a live account. The demo has no real team.' })
      return false
    }
    if (busy !== null) return false
    setBusy(label)
    say(null)
    setError(null)
    setNotice(null)
    try {
      say({ tone: 'good', text: await fn(token) })
      refresh()
      return true
    } catch (err) {
      say({ tone: 'bad', text: describeError(err, 'That didn’t work. Nothing was changed.') })
      return false
    } finally {
      setBusy(null)
    }
  }

  const first = user.name.split(' ')[0]
  const emailDraft = email.trim()
  const emailInvalid = emailProblem(emailDraft, user.email)
  const resetBlocked = user.pending
    ? `${first} hasn’t set a password yet — send their invitation instead.`
    : !user.active
      ? `${first}’s access is switched off. Restore access first.`
      : null

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

      {/* --- account details --------------------------------------------- */}
      {canInvite && (
        <section data-testid="manage-details">
          <h3 className="text-sm font-bold">Account details</h3>
          <dl className="mt-2 grid gap-2 text-sm sm:grid-cols-2">
            <div className="min-w-0">
              <dt className="text-xs text-ink-mute">Name</dt>
              <dd className="truncate font-semibold" data-testid="manage-details-name">{user.name}</dd>
            </div>
            <div className="min-w-0">
              <dt className="text-xs text-ink-mute">Sign-in email</dt>
              <dd className="break-all font-semibold" data-testid="manage-details-email">{user.email ?? '—'}</dd>
            </div>
          </dl>

          {!editingName && !editingEmail && (
            <div className="mt-3 flex flex-wrap gap-2">
              <Button
                size="sm"
                variant="secondary"
                disabled={busy !== null}
                data-testid="manage-edit-name"
                onClick={() => {
                  setFirstName(user.firstName ?? (user.lastName ? '' : user.name))
                  setLastName(user.lastName ?? '')
                  setDetailsSaid(null)
                  setEditingName(true)
                }}
              >
                Edit name
              </Button>
              <Button
                size="sm"
                variant="secondary"
                disabled={busy !== null}
                data-testid="manage-edit-email"
                onClick={() => {
                  setEmail(user.email ?? '')
                  setEmailTouched(false)
                  setDetailsSaid(null)
                  setEditingEmail(true)
                }}
              >
                Change email
              </Button>
            </div>
          )}

          {editingName && (
            <form
              className="mt-3 rounded-field bg-surface-sunk p-3 ring-1 ring-line"
              data-testid="manage-name-form"
              onSubmit={(e) => {
                e.preventDefault()
                void act('name', setDetailsSaid, async (token) => {
                  const r = await apiSetUserName(token, user.id, { firstName: firstName.trim(), lastName: lastName.trim() })
                  setEditingName(false)
                  return `Name saved — the roster and badge now read “${r.name}”.`
                })
              }}
            >
              <div className="grid gap-2 sm:grid-cols-2">
                <label className="block min-w-0">
                  <span className="text-xs font-semibold text-ink-mute">First name</span>
                  <input
                    value={firstName}
                    onChange={(e) => setFirstName(e.target.value)}
                    maxLength={60}
                    autoCapitalize="words"
                    autoComplete="off"
                    data-testid="manage-first-name"
                    className="focusable mt-1 h-11 w-full rounded-lg border border-ink/15 bg-surface px-3 text-sm"
                  />
                </label>
                <label className="block min-w-0">
                  <span className="text-xs font-semibold text-ink-mute">Last name</span>
                  <input
                    value={lastName}
                    onChange={(e) => setLastName(e.target.value)}
                    maxLength={60}
                    autoCapitalize="words"
                    autoComplete="off"
                    data-testid="manage-last-name"
                    className="focusable mt-1 h-11 w-full rounded-lg border border-ink/15 bg-surface px-3 text-sm"
                  />
                </label>
              </div>
              <div className="mt-3 flex flex-wrap gap-2">
                <Button
                  size="sm"
                  type="submit"
                  disabled={busy !== null || (!firstName.trim() && !lastName.trim())}
                  data-testid="manage-name-save"
                >
                  {busy === 'name' ? 'Saving…' : 'Save name'}
                </Button>
                <Button size="sm" variant="secondary" disabled={busy !== null} onClick={() => setEditingName(false)}>
                  Cancel
                </Button>
              </div>
            </form>
          )}

          {editingEmail && (
            <form
              className="mt-3 rounded-field bg-surface-sunk p-3 ring-1 ring-line"
              data-testid="manage-email-form"
              noValidate
              onSubmit={(e) => {
                e.preventDefault()
                setEmailTouched(true)
                if (!emailInvalid) setConfirmEmail(true)
              }}
            >
              <label className="block">
                <span className="text-xs font-semibold text-ink-mute">New sign-in email</span>
                <input
                  type="email"
                  inputMode="email"
                  autoCapitalize="none"
                  autoCorrect="off"
                  spellCheck={false}
                  autoComplete="off"
                  value={email}
                  onChange={(e) => setEmail(e.target.value)}
                  onBlur={() => setEmailTouched(true)}
                  aria-invalid={emailTouched && !!emailInvalid}
                  aria-describedby="manage-email-help"
                  data-testid="manage-email-input"
                  className="focusable mt-1 h-11 w-full rounded-lg border border-ink/15 bg-surface px-3 text-sm aria-[invalid=true]:border-bad"
                />
              </label>
              {emailTouched && emailInvalid ? (
                <p id="manage-email-help" className="mt-1.5 text-xs font-medium text-bad" data-testid="manage-email-invalid">
                  {emailInvalid}
                </p>
              ) : (
                <p id="manage-email-help" className="mt-1.5 text-xs leading-relaxed text-ink-mute">
                  {user.pending
                    ? 'Takes effect immediately. Their current invitation link stops working; send a fresh one to the new address afterwards.'
                    : `Takes effect immediately — there is no verification step. ${isSelf ? 'You keep' : `${first} keeps`} the same password, and we email both addresses to say it changed.`}
                </p>
              )}
              <div className="mt-3 flex flex-wrap gap-2">
                <Button size="sm" type="submit" disabled={busy !== null || (emailTouched && !!emailInvalid)} data-testid="manage-email-continue">
                  Review change
                </Button>
                <Button size="sm" variant="secondary" disabled={busy !== null} onClick={() => setEditingEmail(false)}>
                  Cancel
                </Button>
              </div>
            </form>
          )}

          <SectionMessage said={detailsSaid} testId="manage-details-message" />

          {confirmEmail && (
            <ConfirmDialog
              title="Change sign-in email?"
              confirmLabel="Change email"
              busyLabel="Changing…"
              busy={busy === 'email'}
              testId="manage-email-confirm"
              onCancel={() => setConfirmEmail(false)}
              onConfirm={async () => {
                const done = await act('email', setDetailsSaid, async (token) => {
                  const r = await apiSetUserEmail(token, user.id, emailDraft)
                  if (user.pending) {
                    return `${user.name}’s email is now ${r.email}. The invitation sent to ${r.previous} no longer works — use Send invite below to send a fresh one.`
                  }
                  const told = r.notified.previous && r.notified.next
                    ? 'We emailed both addresses to let them know.'
                    : 'The notice emails could not be sent, so let them know yourself.'
                  return `${isSelf ? 'You' : user.name} now sign${isSelf ? '' : 's'} in with ${r.email}. The password is unchanged. ${told}`
                })
                setConfirmEmail(false)
                if (done) setEditingEmail(false)
              }}
            >
              <p>
                <span className="font-semibold text-ink">{user.email}</span> →{' '}
                <span className="break-all font-semibold text-ink">{emailDraft}</span>
              </p>
              <p className="mt-2">
                {user.pending
                  ? 'This takes effect immediately. Their current invitation link stops working, so send a fresh one to the new address.'
                  : `This takes effect immediately, with no verification step: from ${isSelf ? 'your' : 'their'} next sign-in, only the new address works. The password and everything else on the account stay the same. Both addresses get an email saying it changed.`}
              </p>
            </ConfirmDialog>
          )}
        </section>
      )}

      {/* --- invitation -------------------------------------------------- */}
      {!isSelf && canInvite && user.pending && (
        <section className="border-t border-line-soft pt-4" data-testid="manage-invitation">
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
        <section className="border-t border-line-soft pt-4" data-testid="manage-team">
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
      {isSelf ? (
        <section className={canInvite ? 'border-t border-line-soft pt-4' : ''} data-testid="manage-own-password">
          <h3 className="text-sm font-bold">Your password</h3>
          <p className="mt-1 text-xs leading-relaxed text-ink-mute">
            Changing it signs you out of every device immediately — which is the point when a phone goes missing. You will have to
            sign in again with the new one.
          </p>

          <div className="mt-3 flex gap-2">
            <span className="relative flex-1">
              <input
                type={reveal ? 'text' : 'password'}
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                autoComplete="new-password"
                aria-label="New password"
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
                  setNotice('Password changed. You’ll be signed out — use the new one.')
                })
              }
            >
              {busy === 'password' ? 'Saving…' : 'Set'}
            </Button>
          </div>
        </section>
      ) : (
        canInvite && (
          <section className="border-t border-line-soft pt-4" data-testid="manage-password">
            <h3 className="text-sm font-bold">Password</h3>
            <p className="mt-1 text-xs leading-relaxed text-ink-mute">
              {first} gets an email with a secure link to choose a new password. You never see the link or the password. It works once
              and expires in two days; their current password keeps working until they use it, and setting a new one signs them out
              everywhere.
            </p>
            <Button
              size="sm"
              className="mt-2"
              disabled={busy !== null || !!resetBlocked}
              data-testid="manage-reset-email"
              onClick={() => {
                setResetSaid(null)
                setConfirmReset(true)
              }}
            >
              {busy === 'reset' ? 'Sending…' : 'Send password reset email'}
            </Button>
            {resetBlocked && (
              <p className="mt-1.5 text-xs text-ink-mute" data-testid="manage-reset-blocked">
                {resetBlocked}
              </p>
            )}
            <SectionMessage said={resetSaid} testId="manage-reset-message" />

            {confirmReset && (
              <ConfirmDialog
                title="Send a password reset email?"
                confirmLabel="Send reset email"
                busyLabel="Sending…"
                busy={busy === 'reset'}
                testId="manage-reset-confirm"
                onCancel={() => setConfirmReset(false)}
                onConfirm={async () => {
                  await act('reset', setResetSaid, async (token) => {
                    const r = await apiSendResetEmail(token, user.id)
                    const until = new Date(r.expiresAt).toLocaleString('en-US', {
                      weekday: 'short',
                      month: 'short',
                      day: 'numeric',
                      hour: 'numeric',
                      minute: '2-digit',
                    })
                    return `Reset email sent to ${r.email}. The link works once, until ${until}.`
                  })
                  setConfirmReset(false)
                }}
              >
                <p>
                  We’ll email a secure link to <span className="break-all font-semibold text-ink">{user.email}</span> so {first} can
                  choose a new password.
                </p>
                <p className="mt-2">
                  You won’t see the link or the password. Any earlier reset link stops working. Their current password keeps working
                  until they set a new one.
                </p>
              </ConfirmDialog>
            )}
          </section>
        )
      )}

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
              Re-send their invitation above; they choose their own password from it.
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
