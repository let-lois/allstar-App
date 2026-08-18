import { useEffect, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { TopBar } from '../components/nav/TopBar'
import { SyncDetail, useSync } from '../components/sync/SyncBadge'
import { Button } from '../components/ui/Button'
import { Collapsible } from '../components/ui/Collapsible'
import { useAppStore } from '../store/useAppStore'
import { estimateStorage } from '../lib/db'
import { isForcedOffline, setForcedOffline } from '../lib/api'
import { drain, listOutbox, retryFailed } from '../lib/sync'
import { relative } from '../lib/format'
import type { Mutation } from '../types'
import { IconChevron } from '../components/nav/icons'

const ROLE_LABEL: Record<string, string> = {
  field_rep: 'Field Rep',
  manager: 'Manager',
  client_admin: 'Client Admin',
  super_admin: 'Super Admin',
}

export function More() {
  const nav = useNavigate()
  const user = useAppStore((s) => s.user)
  const signOut = useAppStore((s) => s.signOut)
  const resetDemoData = useAppStore((s) => s.resetDemoData)
  const mode = useAppStore((s) => s.mode)
  const properties = useAppStore((s) => s.properties)
  const photos = useAppStore((s) => s.photos)
  const snap = useSync()

  const [storage, setStorage] = useState<{ usedMB: number; quotaMB: number } | null>(null)
  const [outbox, setOutbox] = useState<Mutation[]>([])
  const [offlineSim, setOfflineSim] = useState(isForcedOffline())
  const [resetting, setResetting] = useState(false)

  useEffect(() => {
    void estimateStorage().then(setStorage)
    void listOutbox().then(setOutbox)
  }, [snap.pending, snap.failed])

  const photoBytes = Object.values(photos).reduce((s, p) => s + p.bytes, 0)

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <TopBar title="More" />

      <div className="scroll-pane pad-nav bg-surface-sunk">
        <div className="content-col space-y-3 p-3">
          {/* --- identity ------------------------------------------------- */}
          <section className="card flex items-center gap-3 p-4">
            <span className="grid h-12 w-12 shrink-0 place-items-center rounded-full bg-brand-500 font-bold text-white">
              {user?.avatarInitials}
            </span>
            <div className="min-w-0 flex-1">
              <p className="truncate font-bold">{user?.name}</p>
              <p className="truncate text-xs text-ink-mute">
                {ROLE_LABEL[user?.role ?? '']} · {user?.clientName}
              </p>
              {/*
                Stated rather than implied. A rep who can't tell whether their
                knocks are going to the company's database or to a sample
                dataset has no way to trust the app, and an admin demoing to a
                prospect needs to know that nothing they tap is real.
              */}
              <p className="mt-1 truncate text-[11px] font-semibold uppercase tracking-wide text-ink-mute">
                {mode === 'live' ? 'Signed in · syncing to server' : 'Demo — sample data'}
              </p>
            </div>
          </section>

          {/* --- sync ----------------------------------------------------- */}
          <section className="card p-4">
            <h2 className="mb-3 font-bold">Sync &amp; offline</h2>
            <SyncDetail />
          </section>

          {/* --- what's cached ------------------------------------------- */}
          <Collapsible
            title="Saved on this phone"
            defaultOpen
            right={
              <span className="nums text-xs text-ink-mute">
                {Object.keys(properties).length} properties
              </span>
            }
          >
            <dl className="grid grid-cols-2 gap-y-2.5 text-sm">
              <Row label="Properties" value={String(Object.keys(properties).length)} />
              <Row label="Photos" value={`${Object.keys(photos).length}`} />
              <Row label="Photo storage" value={`${Math.round(photoBytes / 1024)} KB`} />
              <Row
                label="App storage"
                value={
                  storage
                    ? `${storage.usedMB.toFixed(1)} / ${Math.round(storage.quotaMB)} MB`
                    : 'Unavailable'
                }
              />
              <Row label="Last sync" value={relative(snap.lastSyncedAt)} />
              <Row label="Waiting to upload" value={String(snap.pending)} />
            </dl>
            <p className="mt-3 text-xs leading-relaxed text-ink-mute">
              Your route, leads, contacts, appointments and follow-ups are cached here so
              the app works with no signal. Visits, outcomes, notes and photos are recorded
              locally and uploaded when you reconnect.
            </p>
          </Collapsible>

          {/* --- outbox --------------------------------------------------- */}
          <Collapsible title="Upload queue" count={outbox.length}>
            {outbox.length === 0 ? (
              <p className="text-sm text-ink-mute">Everything is uploaded.</p>
            ) : (
              <>
                <ul className="space-y-2">
                  {outbox.slice(0, 25).map((m) => (
                    <li key={m.id} className="flex items-center gap-2 text-sm">
                      <span
                        className={`h-2 w-2 shrink-0 rounded-full ${
                          m.status === 'failed' ? 'bg-red-500' : 'bg-amber-500'
                        }`}
                      />
                      <span className="min-w-0 flex-1 truncate">{m.kind}</span>
                      <span className="shrink-0 text-xs text-ink-mute">
                        {relative(m.createdAt)}
                      </span>
                    </li>
                  ))}
                </ul>
                <div className="mt-3 flex gap-2">
                  <Button variant="secondary" full onClick={() => void drain()}>
                    Upload now
                  </Button>
                  {snap.failed > 0 && (
                    <Button variant="secondary" full onClick={() => void retryFailed()}>
                      Retry failed
                    </Button>
                  )}
                </div>
              </>
            )}
          </Collapsible>

          {/* --- field testing ------------------------------------------- */}
          <Collapsible title="Field testing">
            <label className="flex min-h-tap items-center justify-between gap-3">
              <span className="min-w-0">
                <span className="block text-sm font-medium">Simulate no signal</span>
                <span className="block text-xs text-ink-mute">
                  Verify the offline flow without leaving coverage.
                </span>
              </span>
              <button
                role="switch"
                aria-checked={offlineSim}
                onClick={() => {
                  const next = !offlineSim
                  setOfflineSim(next)
                  setForcedOffline(next)
                  if (!next) void drain()
                  else window.dispatchEvent(new Event('offline'))
                }}
                className={`relative h-8 w-14 shrink-0 rounded-full transition-colors ${
                  offlineSim ? 'bg-ink' : 'bg-slate-300'
                }`}
              >
                <span
                  className={`absolute top-1 h-6 w-6 rounded-full bg-white transition-transform ${
                    offlineSim ? 'translate-x-7' : 'translate-x-1'
                  }`}
                />
              </button>
            </label>

            {/*
              Demo hygiene: a prospect pokes at the app, records visits, marks
              things sold. This hands the next pitch a clean, identical dataset
              instead of yesterday's fingerprints.

              Hidden on a live account, where there is no seed to restore and the
              button would only offer to delete a rep's real work.
            */}
            {mode === 'demo' && (
              <div className="mt-3 border-t border-slate-100 pt-3">
                <p className="text-sm font-medium">Reset demo data</p>
                <p className="mt-0.5 text-xs text-ink-mute">
                  Restores the sample territory, routes and team activity. Clears any
                  visits, notes and photos recorded on this device.
                </p>
                <Button
                  variant="secondary"
                  full
                  className="mt-2"
                  disabled={resetting}
                  onClick={async () => {
                    if (!window.confirm('Reset the demo? Work recorded on this device is cleared.'))
                      return
                    setResetting(true)
                    try {
                      await resetDemoData()
                    } finally {
                      setResetting(false)
                    }
                  }}
                >
                  {resetting ? 'Resetting…' : 'Reset demo data'}
                </Button>
              </div>
            )}
          </Collapsible>

          <nav className="card overflow-hidden">
            <MoreLink label="Today's route" onClick={() => nav('/route')} />
            <MoreLink label="Add a lead" onClick={() => nav('/lead/new')} />
            <MoreLink label="Schedule an appointment" onClick={() => nav('/schedule/new')} />
            {user?.role !== 'field_rep' && (
              <>
                <MoreLink label="Team activity" onClick={() => nav('/team')} />
                <MoreLink label="Admin console" onClick={() => nav('/admin')} />
              </>
            )}
          </nav>

          <Button
            variant="secondary"
            full
            size="lg"
            onClick={() => void signOut()}
            className="text-red-600"
          >
            Sign out
          </Button>

          <p className="pb-2 text-center text-xs text-ink-mute">Allstar Field · v0.1.0</p>
        </div>
      </div>
    </div>
  )
}

function Row({ label, value }: { label: string; value: string }) {
  return (
    <>
      <dt className="text-ink-mute">{label}</dt>
      <dd className="nums text-right font-medium">{value}</dd>
    </>
  )
}

function MoreLink({ label, onClick }: { label: string; onClick: () => void }) {
  return (
    <button
      onClick={onClick}
      className="flex min-h-[56px] w-full items-center justify-between border-b border-slate-100 px-4 text-left font-medium last:border-0 active:bg-slate-50"
    >
      {label}
      <span className="text-ink-mute">
        <IconChevron />
      </span>
    </button>
  )
}
