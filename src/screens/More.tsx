import { useEffect, useState } from 'react'
import { API_URL } from '../lib/api-url'
import { useNavigate } from 'react-router-dom'
import { TopBar } from '../components/nav/TopBar'
import { SyncDetail, usePhotoSync, useSync } from '../components/sync/SyncBadge'
import { Button } from '../components/ui/Button'
import { SectionHeader } from '../components/ui/Card'
import { Field } from '../components/ui/Input'
import { Collapsible } from '../components/ui/Collapsible'
import { OfflineMaps } from '../components/map/OfflineMaps'
import { useAppStore } from '../store/useAppStore'
import { estimateStorage, storageIsPersisted } from '../lib/db'
import { isForcedOffline, setForcedOffline } from '../lib/api'
import { drain, listOutbox, retryFailed } from '../lib/sync'
import { drainPhotos, retryFailedPhotos } from '../lib/photos'
import { relative } from '../lib/format'
import { ApiError, apiSetPassword } from '../lib/http'
import { liveToken } from '../lib/session'
import type { Mutation } from '../types'
import { IconChevron, IconConsole, IconHelp } from '../components/nav/icons'
import { SignOutButton } from '../components/nav/SignOutButton'
import { HELP_URL } from '../lib/help'
import { AvatarPicker, AvatarRemove } from '../components/ui/AvatarPicker'
import { clearTourSeen } from '../lib/tourState'
import { ThemeToggle } from '../components/ui/ThemeToggle'

const ROLE_LABEL: Record<string, string> = {
  field_rep: 'Field Rep',
  manager: 'Manager',
  client_admin: 'Client Admin',
  super_admin: 'Super Admin',
}

export function More() {
  const nav = useNavigate()
  const requestTour = useAppStore((s) => s.requestTour)

  /*
    Clear the flag and go where the tour lives. It cannot run from this screen —
    every step points at something on Today or at the bar underneath it.
  */
  const replayTour = async () => {
    await clearTourSeen(user ? { id: user.id, role: user.role } : null)
    /*
      Go first, then ask. The tour's first step lives on Today, and asking
      before navigating means it spotlights this screen for a moment before the
      route catches up.
    */
    nav('/')
    requestTour()
  }
  const user = useAppStore((s) => s.user)
  const resetDemoData = useAppStore((s) => s.resetDemoData)
  const mode = useAppStore((s) => s.mode)
  const properties = useAppStore((s) => s.properties)
  const photos = useAppStore((s) => s.photos)
  const snap = useSync()

  const [persisted, setPersisted] = useState<boolean | null>(null)
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
    void storageIsPersisted().then(setPersisted)
  }, [snap.pending, snap.failed])

  const photoBytes = Object.values(photos).reduce((s, p) => s + p.bytes, 0)
  const photoSnap = usePhotoSync()
  /*
    One number for "what has not gone up yet".

    Photos and writes drain separately, but a rep opening this section is asking
    one question, and a queue that reads "0" while forty roof shots sit on the
    phone is the kind of wrong that only shows up after the phone is lost.
  */
  const queued = outbox.length + photoSnap.waiting + photoSnap.failed

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
          <div className="flex items-center gap-3.5 pb-1 pt-1" data-tour="more-avatar">
            <AvatarPicker />
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
              <p className="mt-1 truncate text-[12.5px] font-medium text-ink-mute">
                {mode === 'live' ? 'Signed in · syncing to server' : 'Demo — sample data'}
              </p>
              <AvatarRemove />
            </div>
            {/*
              Appearance sits with the person, not under a heading.

              It is a property of this handset rather than of the account, and
              putting it beside the avatar is the difference between a setting
              somebody finds and a setting somebody is told about.
            */}
            <ThemeToggle />
          </div>


          {/*
            The two shortcuts, right under the name, so neither needs a scroll.
            Help first, for everybody: where somebody stuck looks, and the
            same place the header's question mark opens.
          */}
          <a
            href={HELP_URL}
            target="_blank"
            rel="noopener noreferrer"
            data-testid="more-need-help"
            className="focusable card flex min-h-tap items-center gap-3 px-4 py-3.5"
          >
            <span className="grid h-10 w-10 shrink-0 place-items-center rounded-full bg-surface-tint text-accent-strong">
              <IconHelp />
            </span>
            <span className="min-w-0 flex-1">
              <span className="block text-[15.5px] font-semibold">Need help?</span>
              <span className="block text-[13px] text-ink-mute">Visit the All Star Help Center</span>
            </span>
            <span className="shrink-0 text-accent-strong">
              <IconChevron />
            </span>
          </a>

          {/*
            Then the console, for the roles it is built for and nobody else —
            the same rule its own routes and the Worker enforce, so a rep never
            sees a door that would refuse them. Filled rather than a quiet row:
            it is where an admin's day starts, and it was easy to miss as the
            second line of Manage.
          */}
          {user?.role !== 'field_rep' && (
            <button
              type="button"
              onClick={() => nav('/admin')}
              data-testid="more-console"
              className="metal metal-brand press focusable flex min-h-tap w-full items-center gap-3 rounded-card px-4 py-3.5 text-left"
            >
              <span className="grid h-10 w-10 shrink-0 place-items-center rounded-full bg-white/15" aria-hidden>
                <IconConsole />
              </span>
              <span className="min-w-0 flex-1">
                <span className="block text-[15.5px] font-semibold">Admin console</span>
                <span className="block text-[13px] opacity-90">Team, leads, territories and reports</span>
              </span>
              <span className="shrink-0">
                <IconChevron />
              </span>
            </button>
          )}

          {/*
            The menu, grouped by what it is for, and only what this person can
            use. Where things live after the dock: the work, the office's
            tools, the account, and help. The phone's own housekeeping (sync,
            storage, offline maps) comes after, since it is looked at when
            something is wrong rather than every day.
          */}
          <MoreGroup title="Your work">
            {/* First: the badge is what a rep shows at the door, so it is
                one tap from More rather than tucked into the account rows. */}
            {mode === 'live' && <MoreLink label="My badge" onClick={() => nav('/badge')} />}
            <MoreLink label="Today's route" onClick={() => nav('/route')} />
            <MoreLink label="Lists" onClick={() => nav('/lists')} />
            <MoreLink label="Standings" onClick={() => nav('/standings')} />
            <MoreLink label="Add a lead" onClick={() => nav('/lead/new')} />
            <MoreLink label="Schedule an appointment" onClick={() => nav('/schedule/new')} />
          </MoreGroup>

          {user?.role !== 'field_rep' && (
            <MoreGroup title="Manage">
              <MoreLink label="Team activity" onClick={() => nav('/team')} />
              <MoreLink label="Territories" onClick={() => nav('/admin/territories')} />
            </MoreGroup>
          )}

          {mode === 'live' && (
            <MoreGroup title="Account">
              <MoreLink label="Edit profile" onClick={() => nav('/profile')} />
              {/*
              Self-service, because routing every forgotten password through an
              admin is a support call for something the rep can do in ten seconds
              — usually while standing on a doorstep.
            */}
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
              <MoreLink label="Delete account" onClick={() => nav('/profile#delete-account')} />
            </MoreGroup>
          )}

          <MoreGroup title="Help">
            {/* Plain links: the phone shell opens an https link in the in-app browser. */}
            <MoreHref label="All Star Help" href={HELP_URL} />
            {/*
              Replay, because the tour offers Skip and people take it — often on
              the first morning, standing next to a van. Everyone, not just reps:
              the office has its own tour.
            */}
            <MoreLink label="Show the tutorial again" onClick={() => void replayTour()} />
            <MoreHref label="Privacy policy" href={`${API_URL}/privacy`} />
          </MoreGroup>

          <section className="section">
            <SectionHeader title="This phone" standalone />
          </section>
          {/* --- sync ----------------------------------------------------- */}
          <SyncDetail />

          {/* --- what's cached ------------------------------------------- */}
          <div data-tour="more-sync">
          <Collapsible
            title="Saved on this phone"
            right={
              <span className="nums text-xs text-ink-soft">
                {Object.keys(properties).length} leads
              </span>
            }
          >
            <dl className="grid grid-cols-2 gap-y-3 text-[14px]">
              <Row label="Leads" value={String(Object.keys(properties).length)} />
              <Row label="Photos" value={`${Object.keys(photos).length}`} />
              <Row label="Photo storage" value={`${Math.round(photoBytes / 1024)} KB`} />
              {/*
                Named for what it means to a rep rather than for the flag: the
                question behind it is "if I lose this phone, what goes with it".
              */}
              <Row
                label="Photos uploaded"
                value={
                  photoSnap.localOnly > 0 && photoSnap.waiting + photoSnap.failed === 0
                    ? 'Not enabled'
                    : `${Object.keys(photos).length - photoSnap.waiting - photoSnap.failed} of ${
                        Object.keys(photos).length
                      }`
                }
              />
              <Row
                label="App storage"
                value={
                  storage
                    ? `${storage.usedMB.toFixed(1)} / ${Math.round(storage.quotaMB)} MB`
                    : 'Unavailable'
                }
              />
              {/*
                Reported rather than assumed. The app asks every launch, and
                browsers decide — mostly on whether the app is installed. "Kept"
                means the browser has promised not to clear this to reclaim
                space; "May be cleared" means it has not, which is worth knowing
                before a week away from a phone with unsent work on it.
              */}
              <Row
                label="Storage"
                value={persisted == null ? '—' : persisted ? 'Kept' : 'May be cleared'}
              />
              <Row label="Last sync" value={relative(snap.lastSyncedAt)} />
              <Row label="Waiting to upload" value={String(snap.pending)} />
            </dl>
            <p className="mt-4 text-[13px] leading-relaxed text-ink-mute">
              Your route, leads, contacts, appointments and follow-ups are cached here so
              the app works with no signal. Visits, outcomes, notes and photos are recorded
              locally and uploaded when you reconnect.
            </p>
            {persisted === false && (
              <p className="mt-3 text-[13px] leading-relaxed text-warn">
                This phone may clear the app’s saved data if it runs low on space, or after
                a week or two without opening the app. Adding Allstar to your home screen
                stops that. Anything already uploaded is safe either way.
              </p>
            )}
          </Collapsible>
          </div>

          {/* --- offline maps ---------------------------------------------- */}
          <div data-tour="more-offline-maps">
            <OfflineMaps />
          </div>

          {/* --- outbox --------------------------------------------------- */}
          <Collapsible title="Upload queue" count={queued}>
            {queued === 0 ? (
              <p className="text-sm text-ink-mute">
                {photoSnap.localOnly > 0
                  ? 'Everything is uploaded. Photos stay on this phone — this deployment has no photo storage.'
                  : 'Everything is uploaded.'}
              </p>
            ) : (
              <>
                <ul className="space-y-2">
                  {/*
                    Photos first, and as one line rather than one per photo. A
                    day of knocking is forty of them; listing each would bury
                    the writes underneath, and there is nothing per-photo a rep
                    can do about any of them anyway. What they need is the count
                    and the size, because the size is what the wait costs.
                  */}
                  {photoSnap.waiting + photoSnap.failed > 0 && (
                    <li className="flex min-h-[28px] items-center gap-2.5 text-[14px]">
                      <span
                        className={`h-2 w-2 shrink-0 rounded-full ${
                          photoSnap.failed > 0 ? 'bg-bad' : 'bg-warn'
                        }`}
                      />
                      <span className="min-w-0 flex-1 truncate">
                        {photoSnap.waiting + photoSnap.failed} photo
                        {photoSnap.waiting + photoSnap.failed === 1 ? '' : 's'}
                        {photoSnap.failed > 0 ? ` · ${photoSnap.failed} failed` : ''}
                      </span>
                      <span className="nums shrink-0 text-xs text-ink-mute">
                        {Math.round(photoSnap.waitingBytes / 1024)} KB
                      </span>
                    </li>
                  )}
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
                  <Button
                    variant="secondary"
                    full
                    onClick={() => {
                      void drain()
                      // `drain` chains into the photos once the outbox is
                      // clean, but an outbox that is already empty never gets
                      // there — and an empty outbox with photos still owed is
                      // exactly the state this button exists for.
                      void drainPhotos()
                    }}
                  >
                    Upload now
                  </Button>
                  {snap.failed + photoSnap.failed > 0 && (
                    <Button
                      variant="secondary"
                      full
                      onClick={() => {
                        void retryFailed()
                        void retryFailedPhotos()
                      }}
                    >
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
                /*
                  The button is the tap target, the span inside it is the
                  track. They are separate because a 32px-tall switch is under
                  the tap floor — fine with a mouse, a miss with a thumb on a
                  porch — so the target gets the full 48px of height and the
                  track keeps the 32px the design wants.
                */
                className="focusable flex min-h-tap w-[52px] shrink-0 items-center rounded-full"
              >
                <span
                  className={`relative block h-8 w-full rounded-full transition-colors ${
                    offlineSim ? 'bg-brand-600' : 'bg-ink/15'
                  }`}
                >
                  {/*
                    left-1 is load-bearing. Without a horizontal inset the knob
                    has no containing-block origin, so the browser falls back to
                    its static position — which parked it 30px into a 52px track,
                    and 22px past the end of it once switched on. A white circle
                    on a white card: the switch looked like a solid teal pill
                    with no knob at all, in either state.
                  */}
                  <span
                    className={`absolute left-1 top-1 h-6 w-6 rounded-full bg-white shadow-card transition-transform ${
                      offlineSim ? 'translate-x-5' : 'translate-x-0'
                    }`}
                  />
                </span>
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

          {/* The last row, in the destructive colour, with its confirmation. */}
          <SignOutButton row />

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
/**
 * A destination on the More screen.
 *
 * Deliberately built out of the same parts as a `Collapsible` header — the card
 * shell, the machined face, `min-h-tap`, `px-4 py-3`, 15px medium — because the
 * two sit in one scroll and any difference between them reads as a difference in
 * meaning. The chevron is the only tell, and it points the way it behaves:
 * right for "this leaves the screen", down for "this opens in place".
 */
function MoreHref({ label, href }: { label: string; href: string }) {
  return (
    <div className="card overflow-hidden">
      <a
        href={href}
        target="_blank"
        rel="noopener noreferrer"
        className="metal-row focusable flex min-h-tap w-full items-center justify-between gap-3 px-4 py-3 text-left text-[15px] font-medium"
      >
        {label}
        <span className="shrink-0 text-accent-strong">
          <IconChevron />
        </span>
      </a>
    </div>
  )
}

function MoreLink({ label, onClick }: { label: string; onClick: () => void }) {
  return (
    <div className="card overflow-hidden">
      <button
        onClick={onClick}
        className="metal-row focusable flex min-h-tap w-full items-center justify-between gap-3 px-4 py-3 text-left text-[15px] font-medium"
      >
        {label}
        {/* brand-700, not ink-faint: 5.6:1 on the teal face, where the grey was 2.1. */}
        <span className="shrink-0 text-accent-strong">
          <IconChevron />
        </span>
      </button>
    </div>
  )
}

/** One group of the menu: a quiet heading and its rows. */
function MoreGroup({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="section" aria-label={title}>
      <SectionHeader title={title} standalone />
      <nav className="flex flex-col gap-2.5">{children}</nav>
    </section>
  )
}
