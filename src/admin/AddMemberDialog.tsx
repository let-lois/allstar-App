import { useEffect, useState } from 'react'
import { describeError } from '../lib/errors'
import { Button } from '../components/ui/Button'
import {
  apiCreateTeam,
  apiInvite,
  apiTeams,
  type CreatedInviteDTO,
  type TeamDTO,
} from '../lib/http'
import { liveToken } from '../lib/session'
import { ROLE_BLURB, ROLE_LABEL, grantableRoles } from '../lib/roles'
import { useAppStore } from '../store/useAppStore'
import type { Role } from '../types'

/**
 * Add somebody to the team.
 *
 * An address is enough. Everything else — name, title, team — is what the
 * admin happens to know, and whatever they leave blank the person is asked for
 * themselves when they first open the app. Typing a rep's details for them was
 * the old flow's tax, and it was paid twice: once by the admin, once by the rep
 * correcting it.
 *
 * **What this says about email is exactly what happened.** The server reports
 * whether it sent one. When it did, the screen says so and still shows the
 * link, because "I never got it" is a sentence every admin will hear. When it
 * did not — email is not configured here, or the provider failed — the screen
 * says *nothing* was sent and hands over the link. An admin who believes a rep
 * was notified and finds out a week later that nobody got anything is the bug
 * this component is built around not having.
 */

const inputClass = 'focusable mt-1 h-11 w-full rounded-lg border border-ink/15 px-3 text-sm'
const labelClass = 'text-[12.5px] font-medium text-ink-mute'

export function AddMemberDialog({
  onClose,
  onInvited,
}: {
  onClose: () => void
  onInvited: () => void
}) {
  const [email, setEmail] = useState('')
  const [firstName, setFirstName] = useState('')
  const [lastName, setLastName] = useState('')
  const [jobTitle, setJobTitle] = useState('')
  const [role, setRole] = useState<Role>('field_rep')
  const [teamId, setTeamId] = useState<string>('')
  const [newTeam, setNewTeam] = useState('')

  // Only the roles this person actually holds. Offering an option the server
  // will refuse is worse than not offering it — the admin learns their own
  // permissions from a rejection.
  const signedIn = useAppStore((s) => s.user)
  const mode = useAppStore((s) => s.mode)
  const roles = grantableRoles(signedIn)

  const [teams, setTeams] = useState<TeamDTO[]>([])
  useEffect(() => {
    const t = liveToken()
    if (!t) return
    void apiTeams(t)
      .then((r) => setTeams(r.teams))
      .catch(() => {
        // No team list is not a reason to block adding somebody; the field
        // simply offers "no team" and "new team".
      })
  }, [])

  // Escape closes it. A modal that traps you until you find the right button is
  // a modal people learn to avoid, and every other dialog on the platform does
  // this — the surprise is what makes it feel broken.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose()
    }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [onClose])

  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [created, setCreated] = useState<CreatedInviteDTO | null>(null)
  const [copied, setCopied] = useState(false)

  async function submit(e: React.FormEvent) {
    e.preventDefault()
    if (busy) return
    const token = liveToken()
    if (!token) {
      setError('Adding someone needs a live account. The demo has no real team.')
      return
    }
    if (!email.trim().includes('@')) {
      setError('An email address is needed — it is how they sign in.')
      return
    }
    setBusy(true)
    setError(null)
    try {
      let chosenTeam: string | null | undefined = teamId || undefined
      if (teamId === '__new__') {
        if (!newTeam.trim()) {
          setError('Name the new team, or pick an existing one.')
          setBusy(false)
          return
        }
        const made = await apiCreateTeam(token, newTeam.trim())
        setTeams((prev) => [...prev, made])
        chosenTeam = made.id
      }
      const invite = await apiInvite(token, {
        email: email.trim(),
        role,
        firstName: firstName.trim() || undefined,
        lastName: lastName.trim() || undefined,
        jobTitle: jobTitle.trim() || undefined,
        teamId: chosenTeam,
      })
      setCreated(invite)
      onInvited()
    } catch (err) {
      setError(describeError(err, 'Could not add them. Try again.'))
    } finally {
      setBusy(false)
    }
  }

  async function copy() {
    if (!created || created.alreadyMember) return
    try {
      await navigator.clipboard.writeText(created.url)
      setCopied(true)
      setTimeout(() => setCopied(false), 2000)
    } catch {
      // Clipboard access can be refused. The link is on screen and selectable,
      // so this is a convenience failing, not the feature failing.
      setCopied(false)
    }
  }

  function reset() {
    setCreated(null)
    setEmail('')
    setFirstName('')
    setLastName('')
    setJobTitle('')
    setTeamId('')
    setNewTeam('')
  }

  return (
    <div
      /*
        Sized to the visible viewport, so the keyboard cannot take the form
        with it. See `ConfirmDialog` for the whole reasoning; this dialog is
        the one that needed it most — five fields, a role picker and a submit
        button is taller than a phone before anything is typed.
      */
      className="fixed inset-x-0 top-0 z-50 grid place-items-center bg-black/40 p-4"
      style={{ height: 'var(--app-h, 100dvh)' }}
      role="dialog"
      aria-modal="true"
      aria-label="Add a team member"
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose()
      }}
    >
      {/*
        The panel scrolls as a whole rather than pinning its actions, because
        this one holds three different bodies with three different button rows
        and splitting each of them would be a rewrite where a scroll is enough:
        what matters is that Send invite can be reached at all, which on a
        phone it could not.
      */}
      <div
        className="w-full max-w-lg overflow-y-auto rounded-card bg-surface p-6 shadow-float"
        style={{ maxHeight: 'calc(var(--app-h, 100dvh) - 2rem)' }}
      >
        {created?.alreadyMember ? (
          /*
            The address already belongs to somebody who can sign in. Nothing
            was minted and nothing was sent, and the screen says exactly that.
          */
          <>
            <h2 className="text-[19px] font-semibold tracking-[-0.01em]">
              {created.email} already has an account
            </h2>
            <p className="mt-2 text-sm leading-relaxed text-ink-mute">{created.message}</p>
            <div className="mt-5 flex gap-2 border-t border-line-soft pt-4">
              <Button variant="secondary" onClick={onClose}>
                Done
              </Button>
            </div>
          </>
        ) : created ? (
          <>
            {created.emailed ? (
              <>
                <h2 className="text-[19px] font-semibold tracking-[-0.01em]" data-testid="invite-emailed">
                  Invitation emailed to {created.email}
                </h2>
                <p className="mt-2 text-sm leading-relaxed text-ink-mute">
                  They’ll get a link to open the app and choose a password. It works once and
                  expires {new Date(created.expiresAt).toLocaleDateString()}. If they say it
                  never arrived, the same link is here to send another way.
                </p>
              </>
            ) : (
              <>
                <h2 className="text-[19px] font-semibold tracking-[-0.01em]" data-testid="invite-link-only">
                  Link ready for {created.email}
                </h2>
                <p className="mt-2 text-sm leading-relaxed text-ink-mute">
                  {created.mailError
                    ? `Nothing has been emailed — ${created.mailError} Send this link to them another way.`
                    : 'Nothing has been emailed — email is not set up on this deployment. Send this link to them however you normally would.'}{' '}
                  Opening it lets them choose a password, and it stops working once they do.
                </p>
              </>
            )}

            <div className="mt-4 rounded-field bg-surface-sunk p-3 ring-1 ring-line">
              <p className="break-all font-mono text-xs">{created.url}</p>
            </div>

            <div className="mt-3 flex flex-wrap items-center gap-2">
              <Button onClick={() => void copy()}>{copied ? 'Copied' : 'Copy link'}</Button>
              {!created.emailed && (
                <a
                  href={`mailto:${encodeURIComponent(created.email)}?subject=${encodeURIComponent(
                    'Your Allstar Field login',
                  )}&body=${encodeURIComponent(
                    `Set your password here:\n\n${created.url}\n\nThe link expires in a week.`,
                  )}`}
                  className="press focusable inline-flex min-h-tap items-center rounded-field border border-accent/40 px-4 text-sm font-semibold"
                >
                  Open in email
                </a>
              )}
              <span className="text-xs text-ink-mute">
                Expires {new Date(created.expiresAt).toLocaleDateString()}
              </span>
            </div>

            <div className="mt-5 flex gap-2 border-t border-line-soft pt-4">
              <Button variant="secondary" onClick={onClose}>
                Done
              </Button>
              <Button variant="secondary" onClick={reset}>
                Add someone else
              </Button>
            </div>
          </>
        ) : (
          <form onSubmit={submit} noValidate>
            <h2 className="text-[19px] font-semibold tracking-[-0.01em]">Add a team member</h2>
            <p className="mt-1 text-sm text-ink-mute">
              Only the email is needed. Anything you leave blank, they fill in themselves the
              first time they open the app.
            </p>

            <div className="mt-4 grid gap-3 sm:grid-cols-2">
              <label className="block sm:col-span-2">
                <span className={labelClass}>Email</span>
                <input
                  type="email"
                  value={email}
                  onChange={(e) => setEmail(e.target.value)}
                  autoFocus
                  autoCapitalize="off"
                  autoCorrect="off"
                  spellCheck={false}
                  inputMode="email"
                  className={inputClass}
                  placeholder="marcus@yourcompany.com"
                />
              </label>
              <label className="block">
                <span className={labelClass}>First name (optional)</span>
                <input
                  value={firstName}
                  onChange={(e) => setFirstName(e.target.value)}
                  autoComplete="off"
                  className={inputClass}
                  placeholder="Marcus"
                />
              </label>
              <label className="block">
                <span className={labelClass}>Last name (optional)</span>
                <input
                  value={lastName}
                  onChange={(e) => setLastName(e.target.value)}
                  autoComplete="off"
                  className={inputClass}
                  placeholder="Vance"
                />
              </label>
              <label className="block">
                <span className={labelClass}>Job title (optional)</span>
                <input
                  value={jobTitle}
                  onChange={(e) => setJobTitle(e.target.value)}
                  autoComplete="off"
                  className={inputClass}
                  placeholder="Sales Representative"
                />
              </label>
              <label className="block">
                <span className={labelClass}>Team / office (optional)</span>
                <select
                  value={teamId}
                  onChange={(e) => setTeamId(e.target.value)}
                  className={`${inputClass} bg-surface`}
                  data-testid="team-select"
                >
                  <option value="">No team</option>
                  {teams.map((t) => (
                    <option key={t.id} value={t.id}>
                      {t.name}
                    </option>
                  ))}
                  <option value="__new__">New team…</option>
                </select>
              </label>
              {teamId === '__new__' && (
                <label className="block sm:col-span-2">
                  <span className={labelClass}>New team name</span>
                  <input
                    value={newTeam}
                    onChange={(e) => setNewTeam(e.target.value)}
                    autoFocus
                    className={inputClass}
                    placeholder="Austin office"
                  />
                </label>
              )}
            </div>

            <fieldset className="mt-4">
              <legend className={labelClass}>Role</legend>
              <div className="mt-2 space-y-2">
                {roles.map((r) => (
                  <label
                    key={r}
                    className={`flex cursor-pointer items-start gap-3 rounded-field border p-3 ${
                      role === r ? 'border-brand-500 bg-surface-tint' : 'border-line'
                    }`}
                  >
                    <input
                      type="radio"
                      name="role"
                      className="mt-0.5"
                      checked={role === r}
                      onChange={() => setRole(r)}
                    />
                    <span>
                      <span className="block text-sm font-semibold">{ROLE_LABEL[r]}</span>
                      <span className="block text-xs text-ink-mute">{ROLE_BLURB[r]}</span>
                    </span>
                  </label>
                ))}
              </div>
            </fieldset>

            {error && (
              <p role="alert" className="mt-3 text-sm font-medium text-bad">
                {error}
              </p>
            )}

            {mode === 'live' && (
              <p className="mt-3 text-xs leading-relaxed text-ink-mute">
                They set their own password from a link. You never see or choose it.
              </p>
            )}

            <div className="mt-5 flex gap-2 border-t border-line-soft pt-4">
              <Button type="submit" disabled={busy}>
                {busy ? 'Sending…' : 'Send invite'}
              </Button>
              <Button type="button" variant="secondary" onClick={onClose}>
                Cancel
              </Button>
            </div>
          </form>
        )}
      </div>
    </div>
  )
}
