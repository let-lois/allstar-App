import { useEffect, useState } from 'react'
import { Button } from '../components/ui/Button'
import {
  ApiError,
  apiDeleteUser,
  apiFootprint,
  apiResetLink,
  apiSetActive,
  apiSetPassword,
  apiSetRole,
  type FootprintDTO,
} from '../lib/http'
import { liveToken } from '../lib/session'
import type { Role } from '../types'

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
}

const MIN_PASSWORD = 10

const ROLE_WORD: Record<string, string> = {
  field_rep: 'Field Rep',
  manager: 'Manager',
  client_admin: 'Client Admin',
  super_admin: 'Super Admin',
}

export function ManageUser({
  user,
  isSelf,
  onChanged,
  onClose,
}: {
  user: ManagedUser
  isSelf: boolean
  onChanged: () => void
  onClose: () => void
}) {
  const [busy, setBusy] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [notice, setNotice] = useState<string | null>(null)

  const [password, setPassword] = useState('')
  const [reveal, setReveal] = useState(false)
  const [link, setLink] = useState<string | null>(null)
  const [copied, setCopied] = useState(false)

  const [confirming, setConfirming] = useState(false)
  const [typed, setTyped] = useState('')
  const [foot, setFoot] = useState<FootprintDTO | null>(null)

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

  async function run(label: string, fn: (token: string) => Promise<void>) {
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
      onChanged()
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
        <p role="alert" className="rounded-lg bg-red-50 p-3 text-sm font-medium text-red-800">
          {error}
        </p>
      )}
      {notice && (
        <p role="status" className="rounded-lg bg-emerald-50 p-3 text-sm font-medium text-emerald-800">
          {notice}
        </p>
      )}

      {/* --- password ---------------------------------------------------- */}
      <section>
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
              className="focusable h-11 w-full rounded-lg border border-slate-300 pl-3 pr-16 text-sm"
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

        <div className="mt-3 border-t border-slate-100 pt-3">
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
            <div className="mt-3 rounded-lg bg-surface-sunk p-3 ring-1 ring-slate-200">
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
        <section className="border-t border-slate-100 pt-4">
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
                setNotice(`${user.name} is now a ${ROLE_WORD[next]}.`)
              })
            }
            className="focusable mt-2 h-11 w-full rounded-lg border border-slate-300 bg-surface px-3 text-sm disabled:opacity-60"
          >
            <option value="field_rep">Field Rep — route, map and visits</option>
            <option value="manager">Manager — team activity and reporting</option>
            <option value="client_admin">Client Admin — everything, including the team</option>
          </select>
        </section>
      )}

      {/* --- access ------------------------------------------------------ */}
      {!isSelf && (
        <section className="border-t border-slate-100 pt-4">
          <h3 className="text-sm font-bold">Access</h3>
          {user.pending && user.active && (
            <p className="mt-1 rounded-lg bg-amber-50 p-2.5 text-xs leading-relaxed text-amber-900">
              {user.name} hasn’t opened their invite yet, so they have no password.
              Setting one above works, or create a fresh link — the old one keeps
              working until it expires.
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
        <section className="border-t border-slate-100 pt-4">
          <h3 className="text-sm font-bold text-red-700">Delete permanently</h3>

          {!confirming ? (
            <>
              <p className="mt-1 text-xs leading-relaxed text-ink-mute">
                Erases the account and everything recorded against it. Almost always the
                wrong choice — “Remove from team” above does what people usually mean.
              </p>
              <Button
                variant="secondary"
                className="mt-2 text-red-700"
                onClick={() => setConfirming(true)}
              >
                Delete {user.name}…
              </Button>
            </>
          ) : (
            <div className="mt-2 rounded-xl bg-red-50 p-3 ring-1 ring-red-200">
              <p className="text-sm font-semibold text-red-900">
                This deletes {totalRecords.toLocaleString()} record
                {totalRecords === 1 ? '' : 's'} and cannot be undone.
              </p>

              {foot ? (
                <ul className="mt-2 grid grid-cols-2 gap-x-4 text-xs text-red-900">
                  <Count label="visits" n={foot.visits} />
                  <Count label="notes" n={foot.notes} />
                  <Count label="photos" n={foot.photos} />
                  <Count label="tasks" n={foot.tasks} />
                  <Count label="appointments" n={foot.appointments} />
                  <Count label="activity entries" n={foot.activity} />
                </ul>
              ) : (
                <p className="mt-2 text-xs text-red-900">Counting what would be lost…</p>
              )}

              <p className="mt-2 text-xs text-red-900">
                {foot?.assignedProperties
                  ? `Their ${foot.assignedProperties.toLocaleString()} assigned lead${
                      foot.assignedProperties === 1 ? '' : 's'
                    } will survive and return to Unassigned.`
                  : 'No leads are assigned to them.'}{' '}
                Their doors-per-day history disappears from every report.
              </p>

              <label className="mt-3 block">
                <span className="text-xs font-semibold text-red-900">
                  Type “{user.name}” to confirm
                </span>
                <input
                  value={typed}
                  onChange={(e) => setTyped(e.target.value)}
                  className="focusable mt-1 h-10 w-full rounded-lg border border-red-300 px-3 text-sm"
                />
              </label>

              <div className="mt-3 flex gap-2">
                <Button
                  variant="secondary"
                  className="text-red-700"
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
        <p className="border-t border-slate-100 pt-4 text-xs text-ink-mute">
          You can’t remove or delete your own account — that’s how a company locks
          itself out. Ask another administrator.
        </p>
      )}
    </div>
  )
}

function Count({ label, n }: { label: string; n: number }) {
  return (
    <li className="flex justify-between border-b border-red-200/60 py-0.5">
      <span>{label}</span>
      <span className="nums font-semibold">{n.toLocaleString()}</span>
    </li>
  )
}
