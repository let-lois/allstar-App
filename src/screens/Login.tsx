import { useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { useAppStore } from '../store/useAppStore'
import { DEMO_USERS } from '../data/seed'
import type { Role } from '../types'
import { ApiError, NetworkError } from '../lib/http'
import { InAppBrowserNotice } from '../components/system/InAppBrowserNotice'
import { Wordmark } from '../components/ui/Wordmark'

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
  const nav = useNavigate()
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
      home()
    } catch (err) {
      setError(messageFor(err))
    } finally {
      setBusy(false)
    }
  }

  /*
    Signing in lands on the home tab, whatever the address bar said.

    Nothing used to navigate here at all — the app simply re-rendered around a
    user, on whichever URL happened to be current. Sign out from More and back
    in, and you arrive on More; open a bookmarked lead after a session expires
    and you arrive there. For a rep that is merely odd. For an office role it
    means missing the Overview entirely, which is the one screen the whole role
    is built around.

    `/today` for everybody: it is Today for a rep and the Overview for the
    office, which is what "home" means for each of them.
  */
  const home = () => nav('/today', { replace: true })

  /*
    The login used to hard-code its own dark ground while the rest of the app was
    white. It no longer has to: `surface-sunk` *is* that ground now, and pointing
    this screen at the theme is what keeps the sign-in and the app behind it one
    product rather than two that happen to share a logo.
  */
  return (
    <div className="app-shell bg-surface-sunk text-ink">
      {/* Entry point — the earliest possible place to catch a webview link. */}
      <div className="pad-top shrink-0">
        <InAppBrowserNotice tone="dark" />
      </div>

      <div className="scroll-pane flex flex-col justify-center px-6 py-8">
        <div className="mx-auto w-full max-w-sm">
          <div className="mb-7">
            {/*
              The real artwork on its own light tile, not a knockout of it.

              This screen used to hold the mark and the promise on one dark
              plaque, with the type recoloured to white so it would show. That
              read well and quietly restated the brand in a colour the brand
              does not use. The mark now keeps black, teal and teal, and the
              tile gives it the ground it was drawn for.

              The promise moves out onto the page. It is the app's sentence
              rather than part of the logo, and it never needed to share a panel
              with it.
            */}
            {/*
              Centred, because it is the only thing on this screen narrower than
              the column. Everything under it — the fields, the buttons, the
              rule — runs the full width, so a left-aligned tile reads as an
              alignment mistake rather than as a choice.
            */}
            <div className="flex justify-center">
              <Wordmark width={204} animate />
            </div>
            {/*
              Centred under the mark. The two are one lockup — a centred logo
              with the sentence beneath it flush left reads as two things that
              happen to be stacked, and the eye finds the mismatch before it
              finds the words.

              The fields below stay left-aligned, and that is not the same
              problem: a label sits on the edge of the box it names, so its
              alignment is the box's, not this block's.
            */}
            <h1 className="mt-5 text-balance text-center text-[23px] font-semibold leading-tight tracking-[-0.02em]">
              Field sales, built for the phone.
            </h1>
          </div>

          {sessionExpired && (
            <p
              role="status"
              className="mb-4 rounded-field bg-warn/15 px-3 py-2.5 text-sm text-[#FDE68A] ring-1 ring-warn/25"
            >
              You were signed out. Anything you recorded is still saved on this
              phone and will upload once you sign back in.
            </p>
          )}

          <form onSubmit={submit} noValidate>
            <label className="block">
              <span className="text-[13px] font-medium text-ink-mute">
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
                className="field-sunk mt-1.5 h-14 w-full rounded-field px-4 text-base text-ink placeholder:text-ink-faint"
                placeholder="you@company.com"
              />
            </label>

            <label className="mt-3.5 block">
              <span className="text-[13px] font-medium text-ink-mute">
                Password
              </span>
              <span className="relative mt-1.5 block">
                <input
                  type={reveal ? 'text' : 'password'}
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  autoComplete="current-password"
                  enterKeyHint="go"
                  className="field-sunk h-14 w-full rounded-field pl-4 pr-[76px] text-base text-ink placeholder:text-ink-faint"
                  placeholder="••••••••••"
                />
                <button
                  type="button"
                  onClick={() => setReveal((v) => !v)}
                  aria-pressed={reveal}
                  className="metal metal-dark focusable absolute right-1.5 top-1.5 grid h-11 w-[64px] place-items-center rounded-field text-xs font-semibold uppercase tracking-wide"
                >
                  {reveal ? 'Hide' : 'Show'}
                </button>
              </span>
            </label>

            {error && (
              <p role="alert" className="mt-3 text-sm font-medium text-[#FCA5A5]">
                {error}
              </p>
            )}

            {/*
              Flat brand teal with a near-black label.

              `brand-500` rather than the darker `brand-600` a primary button
              uses on white: on this near-black ground the deeper teal reads as
              disabled. Near-black on #0FA9B8 measures 6.24:1 — the same
              inversion, without the gradient it used to need to justify itself.

              This was the one thing the flattening pass actually broke. The
              button carried the gradient rule's class, and with that rule gone it
              had no background at all — so the primary action on the first screen
              of the product was invisible white text on navy. `verify:classes`
              exists because of this button.
            */}
            <button
              type="submit"
              disabled={busy}
              className="metal metal-brand press focusable mt-5 grid h-14 w-full place-items-center rounded-field text-[17px] font-semibold disabled:opacity-60"
            >
              {busy ? 'Signing in…' : 'Sign in'}
            </button>
          </form>

          {/* --- the demo, kept alongside rather than behind a flag --------- */}
          <div className="mt-8 flex items-center gap-3">
            <span className="h-px flex-1 bg-line" />
            <span className="text-[12px] font-medium uppercase tracking-[0.08em] text-ink-mute">
              or
            </span>
            <span className="h-px flex-1 bg-line" />
          </div>

          {!showDemo ? (
            <button
              type="button"
              onClick={() => setShowDemo(true)}
              className="metal metal-dark press focusable mt-4 grid h-14 w-full place-items-center rounded-field text-[16px] font-semibold"
            >
              Try the demo
            </button>
          ) : (
            <>
              <p className="mb-3 mt-5 text-[13px] font-medium text-ink-mute">
                Demo — sample data, no account
              </p>
              <ul className="space-y-2.5">
                {DEMO_USERS.map((u) => (
                  <li key={u.id}>
                    <button
                      onClick={() => void signInDemo(u.id).then(home)}
                      className="metal metal-dark press focusable flex min-h-[68px] w-full items-center gap-3 rounded-card px-4 text-left"
                    >
                      <span className="grid h-11 w-11 shrink-0 place-items-center rounded-full bg-surface-tint text-sm font-semibold text-accent-strong">
                        {u.avatarInitials}
                      </span>
                      <span className="min-w-0 flex-1">
                        <span className="block text-[15px] font-semibold">{u.name}</span>
                        <span className="mt-0.5 block truncate text-[13px] text-ink-faint">
                          {ROLE_BLURB[u.role]}
                        </span>
                      </span>
                      {u.role === 'field_rep' && (
                        <span className="shrink-0 rounded-full bg-brand-400/20 px-2.5 py-1 text-[11px] font-semibold uppercase tracking-[0.06em] text-accent-strong">
                          Field
                        </span>
                      )}
                    </button>
                  </li>
                ))}
              </ul>
            </>
          )}

          <p className="mt-8 text-center text-[12.5px] leading-relaxed text-ink-faint">
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
