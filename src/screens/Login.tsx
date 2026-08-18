import { useState } from 'react'
import { useAppStore } from '../store/useAppStore'
import { DEMO_USERS } from '../data/seed'
import type { Role } from '../types'
import { ApiError, NetworkError } from '../lib/http'
import { InAppBrowserNotice } from '../components/system/InAppBrowserNotice'

const ROLE_BLURB: Record<Role, string> = {
  field_rep: 'Route, map, visits — the full field experience',
  manager: 'Team activity, rep performance, assignments',
  client_admin: 'Company overview, pipeline, team',
  super_admin: 'Platform overview across all clients',
}

/**
 * Sign in.
 *
 * Two doors, and the split is deliberate. Real credentials go to the API; the
 * demo is the seeded dataset with no account and no server, which is what gets
 * shown to a prospect on a trade-show floor with hotel wifi. Keeping the demo as
 * a first-class path rather than a hidden flag means the pitch can't be broken
 * by a backend outage.
 *
 * Everything is sized for the actual moment of use: 6am, in a truck, one hand,
 * gloves on. 56px targets, a password reveal (a mistyped password you can't see
 * is the single most common reason a rep gives up on a login screen), and the
 * keyboard hints set so the email field doesn't autocapitalise.
 */
export function Login() {
  const signInLive = useAppStore((s) => s.signInLive)
  const signInDemo = useAppStore((s) => s.signInDemo)
  const sessionExpired = useAppStore((s) => s.sessionExpired)

  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [reveal, setReveal] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [showDemo, setShowDemo] = useState(false)

  async function submit(e: React.FormEvent) {
    e.preventDefault()
    if (busy) return
    if (!email.trim() || !password) {
      setError('Enter your email and password.')
      return
    }
    setBusy(true)
    setError(null)
    try {
      await signInLive(email, password)
    } catch (err) {
      setError(messageFor(err))
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="app-shell bg-ink text-white">
      {/* Entry point — the earliest possible place to catch a webview link. */}
      <div className="pad-top shrink-0">
        <InAppBrowserNotice tone="dark" />
      </div>

      <div className="scroll-pane flex flex-col justify-center px-6 py-8">
        <div className="mx-auto w-full max-w-sm">
          <div className="mb-7">
            <span className="grid h-14 w-14 place-items-center rounded-2xl bg-brand-500 text-2xl font-black">
              A
            </span>
            <h1 className="mt-5 text-3xl font-black leading-tight">Allstar Field</h1>
            <p className="mt-1.5 text-sm text-slate-400">Field sales, built for the phone.</p>
          </div>

          {sessionExpired && (
            <p
              role="status"
              className="mb-4 rounded-xl bg-amber-500/15 px-3 py-2.5 text-sm text-amber-200 ring-1 ring-amber-400/30"
            >
              You were signed out. Anything you recorded is still saved on this
              phone and will upload once you sign back in.
            </p>
          )}

          <form onSubmit={submit} noValidate>
            <label className="block">
              <span className="text-xs font-semibold uppercase tracking-wide text-slate-400">
                Email
              </span>
              <input
                type="email"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                autoComplete="username"
                inputMode="email"
                autoCapitalize="off"
                autoCorrect="off"
                spellCheck={false}
                enterKeyHint="next"
                /* 16px minimum: anything smaller makes iOS Safari zoom the page
                   on focus, and the rep then has to pinch back out to find the
                   password field. */
                className="focusable mt-1.5 h-14 w-full rounded-xl bg-white/5 px-4 text-base text-white ring-1 ring-white/15 placeholder:text-slate-500"
                placeholder="you@company.com"
              />
            </label>

            <label className="mt-3.5 block">
              <span className="text-xs font-semibold uppercase tracking-wide text-slate-400">
                Password
              </span>
              <span className="relative mt-1.5 block">
                <input
                  type={reveal ? 'text' : 'password'}
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  autoComplete="current-password"
                  enterKeyHint="go"
                  className="focusable h-14 w-full rounded-xl bg-white/5 pl-4 pr-[76px] text-base text-white ring-1 ring-white/15 placeholder:text-slate-500"
                  placeholder="••••••••••"
                />
                <button
                  type="button"
                  onClick={() => setReveal((v) => !v)}
                  aria-pressed={reveal}
                  className="focusable absolute right-1 top-1 grid h-12 w-[68px] place-items-center rounded-lg text-xs font-bold uppercase tracking-wide text-slate-300 active:bg-white/10"
                >
                  {reveal ? 'Hide' : 'Show'}
                </button>
              </span>
            </label>

            {error && (
              <p role="alert" className="mt-3 text-sm font-medium text-rose-300">
                {error}
              </p>
            )}

            <button
              type="submit"
              disabled={busy}
              className="press focusable mt-5 grid h-14 w-full place-items-center rounded-xl bg-brand-500 text-base font-bold text-white active:bg-brand-600 disabled:opacity-60"
            >
              {busy ? 'Signing in…' : 'Sign in'}
            </button>
          </form>

          {/* --- the demo, kept alongside rather than behind a flag --------- */}
          <div className="mt-8 flex items-center gap-3">
            <span className="h-px flex-1 bg-white/10" />
            <span className="text-[11px] font-semibold uppercase tracking-wide text-slate-500">
              or
            </span>
            <span className="h-px flex-1 bg-white/10" />
          </div>

          {!showDemo ? (
            <button
              type="button"
              onClick={() => setShowDemo(true)}
              className="press focusable mt-4 grid h-14 w-full place-items-center rounded-xl bg-white/5 text-base font-semibold text-white ring-1 ring-white/15 active:bg-white/10"
            >
              Try the demo
            </button>
          ) : (
            <>
              <p className="mb-3 mt-5 text-xs font-semibold uppercase tracking-wide text-slate-500">
                Demo — sample data, no account
              </p>
              <ul className="space-y-2.5">
                {DEMO_USERS.map((u) => (
                  <li key={u.id}>
                    <button
                      onClick={() => void signInDemo(u.id)}
                      className="press focusable flex min-h-[68px] w-full items-center gap-3 rounded-2xl bg-white/5 px-4 text-left ring-1 ring-white/10 active:bg-white/10"
                    >
                      <span className="grid h-11 w-11 shrink-0 place-items-center rounded-full bg-brand-500 text-sm font-bold">
                        {u.avatarInitials}
                      </span>
                      <span className="min-w-0 flex-1">
                        <span className="block font-semibold">{u.name}</span>
                        <span className="block truncate text-xs text-slate-400">
                          {ROLE_BLURB[u.role]}
                        </span>
                      </span>
                      {u.role === 'field_rep' && (
                        <span className="shrink-0 rounded-full bg-brand-500/20 px-2 py-1 text-[10px] font-bold uppercase tracking-wide text-brand-300">
                          Field
                        </span>
                      )}
                    </button>
                  </li>
                ))}
              </ul>
            </>
          )}

          <p className="mt-8 text-center text-xs leading-relaxed text-slate-500">
            Your work is saved on this device first and uploads automatically when
            you have signal.
          </p>
        </div>
      </div>
    </div>
  )
}

/**
 * Turns a thrown error into something a rep can act on.
 *
 * "Incorrect email or password" comes from the server and is deliberately
 * ambiguous about which — telling someone the email was right is how an
 * attacker enumerates accounts. Everything else gets the distinction that
 * actually matters in the field: is it me, or is it the signal?
 */
function messageFor(err: unknown): string {
  if (err instanceof NetworkError) {
    return navigator.onLine
      ? "Couldn't reach the server. Try again in a moment."
      : "You're offline. Sign in needs a connection — the demo works without one."
  }
  if (err instanceof ApiError) {
    // A reference only appears on a real server fault, so quoting it here can't
    // make an ordinary wrong password look like a broken system.
    return err.reference ? `${err.message} (reference ${err.reference})` : err.message
  }
  return 'Something went wrong. Try again.'
}
