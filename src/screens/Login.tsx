import { useAppStore } from '../store/useAppStore'
import { DEMO_USERS } from '../data/seed'
import type { Role } from '../types'
import { InAppBrowserNotice } from '../components/system/InAppBrowserNotice'

const ROLE_BLURB: Record<Role, string> = {
  field_rep: 'Route, map, visits — the full field experience',
  manager: 'Team activity, rep performance, assignments',
  client_admin: 'Company overview, pipeline, team',
  super_admin: 'Platform overview across all clients',
}

/**
 * Role picker standing in for real auth.
 *
 * Kept as a single tall column of 64px targets — this is the first thing a rep
 * touches at 6am in a truck, and it should work one-handed without aiming.
 */
export function Login() {
  const signIn = useAppStore((s) => s.signIn)

  return (
    <div className="app-shell bg-ink text-white">
      {/* Entry point — the earliest possible place to catch a webview link. */}
      <div className="pad-top shrink-0">
        <InAppBrowserNotice tone="dark" />
      </div>
      <div className="scroll-pane flex flex-col justify-center px-6 py-10">
        <div className="mx-auto w-full max-w-sm">
          <div className="mb-8">
            <span className="grid h-14 w-14 place-items-center rounded-2xl bg-brand-500 text-2xl font-black">
              A
            </span>
            <h1 className="mt-5 text-3xl font-black leading-tight">Allstar Field</h1>
            <p className="mt-1.5 text-sm text-slate-400">
              Field sales, built for the phone.
            </p>
          </div>

          <p className="mb-3 text-xs font-semibold uppercase tracking-wide text-slate-500">
            Continue as
          </p>

          <ul className="space-y-2.5">
            {DEMO_USERS.map((u) => (
              <li key={u.id}>
                <button
                  onClick={() => void signIn(u.id)}
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

          <p className="mt-8 text-center text-xs leading-relaxed text-slate-500">
            Your work is saved on this device first and uploads automatically when
            you have signal.
          </p>
        </div>
      </div>
    </div>
  )
}
