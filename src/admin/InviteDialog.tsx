import { useState } from 'react'
import { Button } from '../components/ui/Button'
import { ApiError, apiInvite, type CreatedInviteDTO } from '../lib/http'
import { liveToken } from '../lib/session'
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

const ROLES: { value: Role; label: string; blurb: string }[] = [
  { value: 'field_rep', label: 'Field Rep', blurb: 'Route, map and visits on their phone' },
  { value: 'manager', label: 'Manager', blurb: 'Team activity and reporting, plus the field app' },
  { value: 'client_admin', label: 'Client Admin', blurb: 'Everything, including team and settings' },
]

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
    if (!created) return
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
      <div className="w-full max-w-lg rounded-2xl bg-surface p-6 shadow-float">
        {created ? (
          <>
            <h2 className="text-xl font-black">Invite ready for {created.email}</h2>
            <p className="mt-2 text-sm leading-relaxed text-ink-mute">
              Nothing has been emailed — there’s no mail service connected yet. Send
              this link to them however you normally would. Opening it lets them
              choose a password, and it stops working once they do.
            </p>

            <div className="mt-4 rounded-xl bg-surface-sunk p-3 ring-1 ring-slate-200">
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
                className="press focusable inline-flex min-h-tap items-center rounded-xl border border-slate-200 px-4 text-sm font-semibold"
              >
                Open in email
              </a>
              <span className="text-xs text-ink-mute">
                Expires {new Date(created.expiresAt).toLocaleDateString()}
              </span>
            </div>

            <div className="mt-5 flex gap-2 border-t border-slate-100 pt-4">
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
            <h2 className="text-xl font-black">Invite someone</h2>
            <p className="mt-1 text-sm text-ink-mute">
              They’ll get a link to set their own password. You never see or set it.
            </p>

            <div className="mt-4 grid gap-3 sm:grid-cols-2">
              <label className="block">
                <span className="text-xs font-semibold uppercase tracking-wide text-ink-mute">
                  Name
                </span>
                <input
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                  autoFocus
                  className="focusable mt-1 h-11 w-full rounded-lg border border-slate-300 px-3 text-sm"
                  placeholder="Marcus Vance"
                />
              </label>
              <label className="block">
                <span className="text-xs font-semibold uppercase tracking-wide text-ink-mute">
                  Email
                </span>
                <input
                  type="email"
                  value={email}
                  onChange={(e) => setEmail(e.target.value)}
                  autoCapitalize="off"
                  autoCorrect="off"
                  spellCheck={false}
                  className="focusable mt-1 h-11 w-full rounded-lg border border-slate-300 px-3 text-sm"
                  placeholder="marcus@yourcompany.com"
                />
              </label>
              <label className="block sm:col-span-2">
                <span className="text-xs font-semibold uppercase tracking-wide text-ink-mute">
                  Phone (optional)
                </span>
                <input
                  value={phone}
                  onChange={(e) => setPhone(e.target.value)}
                  inputMode="tel"
                  className="focusable mt-1 h-11 w-full rounded-lg border border-slate-300 px-3 text-sm"
                  placeholder="(512) 555-0134"
                />
              </label>
            </div>

            <fieldset className="mt-4">
              <legend className="text-xs font-semibold uppercase tracking-wide text-ink-mute">
                Role
              </legend>
              <div className="mt-2 space-y-2">
                {ROLES.map((r) => (
                  <label
                    key={r.value}
                    className={`flex cursor-pointer items-start gap-3 rounded-xl border p-3 ${
                      role === r.value ? 'border-brand-500 bg-brand-50' : 'border-slate-200'
                    }`}
                  >
                    <input
                      type="radio"
                      name="role"
                      className="mt-0.5"
                      checked={role === r.value}
                      onChange={() => setRole(r.value)}
                    />
                    <span>
                      <span className="block text-sm font-semibold">{r.label}</span>
                      <span className="block text-xs text-ink-mute">{r.blurb}</span>
                    </span>
                  </label>
                ))}
              </div>
            </fieldset>

            {error && (
              <p role="alert" className="mt-3 text-sm font-medium text-red-700">
                {error}
              </p>
            )}

            <div className="mt-5 flex gap-2 border-t border-slate-100 pt-4">
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
