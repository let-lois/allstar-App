import { useEffect, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { TopBar } from '../components/nav/TopBar'
import { SyncDetail, useSync } from '../components/sync/SyncBadge'
import { Button } from '../components/ui/Button'
import { SectionHeader } from '../components/ui/Card'
import { Field } from '../components/ui/Input'
import { Avatar } from '../components/ui/Avatar'
import { Collapsible } from '../components/ui/Collapsible'
import { OfflineMaps } from '../components/map/OfflineMaps'
import { useAppStore } from '../store/useAppStore'
import { estimateStorage } from '../lib/db'
import { isForcedOffline, setForcedOffline } from '../lib/api'
import { drain, listOutbox, retryFailed } from '../lib/sync'
import { relative } from '../lib/format'
import { ApiError, apiSetPassword } from '../lib/http'
import { liveToken } from '../lib/session'
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
  const [pw, setPw] = useState('')
  const [pwBusy, setPwBusy] = useState(false)
  const [pwMsg, setPwMsg] = useState<string | null>(null)
  const [pwErr, setPwErr] = useState<string | null>(null)

  useEffect(() => {
    void estimateStorage().then(setStorage)
    void listOutbox().then(setOutbox)
  }, [snap.pending, snap.failed])

  const photoBytes = Object.values(photos).reduce((s, p) => s + p.bytes, 0)

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <TopBar title="More" />

      <div className="scroll-pane pad-nav bg-surface-sunk">
        <div className="content-col page anim-rise">
          {/*
            --- identity -------------------------------------------------
            Not in a card. Who you are is the page's own heading, and wrapping it
            in a bordered rectangle made it read as the first of six widgets
            rather than as the top of a settings screen.
          */}
          <div className="flex items-center gap-3.5 pb-1 pt-1">
            <Avatar initials={user?.avatarInitials ?? '?'} name={user?.name} size="lg" />
            <div className="min-w-0 flex-1">
              <p className="truncate text-[19px] font-semibold tracking-[-0.01em]">{user?.name}</p>
              <p className="truncate text-[13.5px] text-ink-mute">
                {ROLE_LABEL[user?.role ?? '']} · {user?.clientName}
              </p>
              {/*
                Stated rather than implied. A rep who can't tell whether their
                knocks are going to the company's database or to a sample
                dataset has no way to trust the app, and an admin demoing to a
                prospect needs to know that nothing they tap is real.
              */}
              <p className="mt-1 truncate text-[12.5px] font-medium text-ink-faint">
                {mode === 'live' ? 'Signed in · syncing to server' : 'Demo — sample data'}
              </p>
            </div>
          </div>

          {/* --- sync ----------------------------------------------------- */}
          <section className="section">
            <SectionHeader title="Sync &amp; offline" standalone />
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
            <dl className="grid grid-cols-2 gap-y-3 text-[14px]">
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
            <p className="mt-4 text-[13px] leading-relaxed text-ink-mute">
              Your route, leads, contacts, appointments and follow-ups are cached here so
              the app works with no signal. Visits, outcomes, notes and photos are recorded
              locally and uploaded when you reconnect.
            </p>
          </Collapsible>

          {/* --- offline maps ---------------------------------------------- */}
          <OfflineMaps />

          {/* --- outbox --------------------------------------------------- */}
          <Collapsible title="Upload queue" count={outbox.length}>
            {outbox.length === 0 ? (
              <p className="text-sm text-ink-mute">Everything is uploaded.</p>
            ) : (
              <>
                <ul className="space-y-2">
                  {outbox.slice(0, 25).map((m) => (
                    <li key={m.id} className="flex min-h-[28px] items-center gap-2.5 text-[14px]">
                      <span
                        className={`h-2 w-2 shrink-0 rounded-full ${
                          m.status === 'failed' ? 'bg-bad' : 'bg-warn'
                        }`}
                      />
                      <span className="min-w-0 flex-1 truncate">{m.kind}</span>
                      <span className="shrink-0 text-xs text-ink-mute">
                        {relative(m.createdAt)}
                      </span>
                    </li>
                  ))}
                </ul>
                <div className="mt-4 flex gap-2.5">
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
                <span className="block text-[15px] font-semibold">Simulate no signal</span>
                <span className="mt-0.5 block text-[13px] text-ink-mute">
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
                className={`focusable relative h-8 w-[52px] shrink-0 rounded-full transition-colors ${
                  offlineSim ? 'bg-brand-600' : 'bg-ink/15'
                }`}
              >
                <span
                  className={`absolute top-1 h-6 w-6 rounded-full bg-white shadow-card transition-transform ${
                    offlineSim ? 'translate-x-[24px]' : 'translate-x-1'
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
              <div className="mt-4 border-t border-line-soft pt-4">
                <p className="text-[15px] font-semibold">Reset demo data</p>
                <p className="mt-1 text-[13px] leading-snug text-ink-mute">
                  Restores the sample territory, routes and team activity. Clears any
                  visits, notes and photos recorded on this device.
                </p>
                <Button
                  variant="secondary"
                  full
                  className="mt-3"
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

          <section className="section">
            <SectionHeader title="Go to" standalone />
            <nav className="plate row-group -mx-4 overflow-hidden sm:mx-0 sm:rounded-card sm:border">
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
          </section>

          {/*
            Self-service, because routing every forgotten password through an
            admin is a support call for something the rep can do in ten seconds
            — usually while standing on a doorstep.
          */}
          {mode === 'live' && (
            <Collapsible title="Change my password">
              <p className="text-[13px] leading-relaxed text-ink-mute">
                Changing it signs you out on every device, including this one. Anything
                you’ve recorded is saved here and uploads once you sign back in.
              </p>
              <Field
                type="password"
                value={pw}
                onChange={(e) => setPw(e.target.value)}
                autoComplete="new-password"
                placeholder="At least 10 characters"
                className="mt-4"
                error={pwErr}
              />
              {pwMsg && (
                <p role="status" className="mt-2 text-[13px] font-semibold text-good">
                  {pwMsg}
                </p>
              )}
              <Button
                size="lg"
                full
                className="mt-4"
                disabled={pwBusy || pw.length < 10}
                onClick={async () => {
                  const token = liveToken()
                  if (!token || !user) return
                  setPwBusy(true)
                  setPwErr(null)
                  setPwMsg(null)
                  try {
                    await apiSetPassword(token, user.id, pw)
                    setPw('')
                    setPwMsg('Changed. Sign in again with the new one.')
                  } catch (err) {
                    setPwErr(
                      err instanceof ApiError ? err.message : 'Could not change it. Try again.',
                    )
                  } finally {
                    setPwBusy(false)
                  }
                }}
              >
                {pwBusy ? 'Changing…' : 'Change password'}
              </Button>
            </Collapsible>
          )}

          <Button
            variant="secondary"
            full
            size="lg"
            onClick={() => void signOut()}
            className="mt-1 text-bad"
          >
            Sign out
          </Button>

          <p className="pb-1 pt-1 text-center text-[12.5px] text-ink-mute">
            Allstar Field · v0.1.0
          </p>
        </div>
      </div>
    </div>
  )
}

function Row({ label, value }: { label: string; value: string }) {
  return (
    <>
      <dt className="text-ink-mute">{label}</dt>
      <dd className="nums text-right font-semibold text-ink">{value}</dd>
    </>
  )
}

/** One settings row: label, chevron, 56px of thumb. */
function MoreLink({ label, onClick }: { label: string; onClick: () => void }) {
  return (
    <button
      onClick={onClick}
      className="flex min-h-[56px] w-full items-center justify-between gap-3 px-4 text-left text-[15px] font-medium active:bg-surface-field"
    >
      {label}
      <span className="shrink-0 text-ink-faint">
        <IconChevron />
      </span>
    </button>
  )
}
