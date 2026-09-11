import { useEffect, useState } from 'react'
import { Button } from '../components/ui/Button'
import { ApiError, apiInvite, type CreatedInviteDTO } from '../lib/http'
import { liveToken } from '../lib/session'
import { ROLE_BLURB, ROLE_LABEL, grantableRoles } from '../lib/roles'
import { useAppStore } from '../store/useAppStore'
import type { Role } from '../types'

/**
 * Invite someone onto the team.
 *
 * The thing to be honest about here: **no email is sent.** There is no mail
 * service wired up, and pretending otherwise would be the worst kind of bug —
 * an admin clicks "invite", believes a rep was notified, and finds out a week
 * later that nobody ever got anything.
 *
 * So the flow ends where it actually ends: with a link, shown large, with a copy
 * button and a plain instruction to send it. That's a smaller product than
 * "invitation sent", and a truthful one.
 */



export function InviteDialog({
  onClose,
  onInvited,
}: {
  onClose: () => void
  onInvited: () => void
}) {
  const [name, setName] = useState('')
  const [email, setEmail] = useState('')
  const [phone, setPhone] = useState('')
  const [role, setRole] = useState<Role>('field_rep')

  // Only the roles this person actually holds. Offering an option the server
  // will refuse is worse than not offering it — the admin learns their own
  // permissions from a rejection.
  const signedIn = useAppStore((s) => s.user)
  const roles = grantableRoles(signedIn)

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
      setError('Inviting someone needs a live account. The demo has no real team.')
      return
    }
    if (!name.trim() || !email.trim()) {
      setError('A name and an email are both needed.')
      return
    }
    setBusy(true)
    setError(null)
    try {
      const invite = await apiInvite(token, {
        name: name.trim(),
        email: email.trim(),
        role,
        phone: phone.trim() || undefined,
      })
      setCreated(invite)
      onInvited()
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not create the invite. Try again.')
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

  return (
    <div
      className="fixed inset-0 z-50 grid place-items-center bg-black/40 p-4"
      role="dialog"
      aria-modal="true"
      aria-label="Invite someone"
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose()
      }}
    >
      <div className="w-full max-w-lg rounded-card bg-surface p-6 shadow-float">
        {created?.alreadyMember ? (
          /*
            The address already belongs to somebody who can sign in. Nothing
            was minted and nothing was sent, and the screen says exactly that —
            an admin left believing an invitation went out is the failure.
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
            <h2 className="text-[19px] font-semibold tracking-[-0.01em]">Invite ready for {created.email}</h2>
            <p className="mt-2 text-sm leading-relaxed text-ink-mute">
              Nothing has been emailed — there’s no mail service connected yet. Send
              this link to them however you normally would. Opening it lets them
              choose a password, and it stops working once they do.
            </p>

            <div className="mt-4 rounded-field bg-surface-sunk p-3 ring-1 ring-line">
              <p className="break-all font-mono text-xs">{created.url}</p>
            </div>

            <div className="mt-3 flex flex-wrap items-center gap-2">
              <Button onClick={() => void copy()}>{copied ? 'Copied' : 'Copy link'}</Button>
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
              <span className="text-xs text-ink-mute">
                Expires {new Date(created.expiresAt).toLocaleDateString()}
              </span>
            </div>

            <div className="mt-5 flex gap-2 border-t border-line-soft pt-4">
              <Button variant="secondary" onClick={onClose}>
                Done
              </Button>
              <Button
                variant="secondary"
                onClick={() => {
                  setCreated(null)
                  setName('')
                  setEmail('')
                  setPhone('')
                }}
              >
                Invite someone else
              </Button>
            </div>
          </>
        ) : (
          <form onSubmit={submit}>
            <h2 className="text-[19px] font-semibold tracking-[-0.01em]">Invite someone</h2>
            <p className="mt-1 text-sm text-ink-mute">
              They’ll get a link to set their own password. You never see or set it.
            </p>

            <div className="mt-4 grid gap-3 sm:grid-cols-2">
              <label className="block">
                <span className="text-[12.5px] font-medium text-ink-mute">
                  Name
                </span>
                <input
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                  autoFocus
                  className="focusable mt-1 h-11 w-full rounded-lg border border-ink/15 px-3 text-sm"
                  placeholder="Marcus Vance"
                />
              </label>
              <label className="block">
                <span className="text-[12.5px] font-medium text-ink-mute">
                  Email
                </span>
                <input
                  type="email"
                  value={email}
                  onChange={(e) => setEmail(e.target.value)}
                  autoCapitalize="off"
                  autoCorrect="off"
                  spellCheck={false}
                  className="focusable mt-1 h-11 w-full rounded-lg border border-ink/15 px-3 text-sm"
                  placeholder="marcus@yourcompany.com"
                />
              </label>
              <label className="block sm:col-span-2">
                <span className="text-[12.5px] font-medium text-ink-mute">
                  Phone (optional)
                </span>
                <input
                  value={phone}
                  onChange={(e) => setPhone(e.target.value)}
                  inputMode="tel"
                  className="focusable mt-1 h-11 w-full rounded-lg border border-ink/15 px-3 text-sm"
                  placeholder="(512) 555-0134"
                />
              </label>
            </div>

            <fieldset className="mt-4">
              <legend className="text-[12.5px] font-medium text-ink-mute">
                Role
              </legend>
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

            <div className="mt-5 flex gap-2 border-t border-line-soft pt-4">
              <Button type="submit" disabled={busy}>
                {busy ? 'Creating…' : 'Create invite'}
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
