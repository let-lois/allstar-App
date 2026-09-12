import { Suspense, lazy, useEffect, useState } from 'react'
import { Navigate, Route, Routes, useLocation } from 'react-router-dom'
import { useAppStore } from './store/useAppStore'
import { BottomNav, SideRail } from './components/nav/BottomNav'
import { QuickActions } from './components/nav/QuickActions'
import { OfflineBanner } from './components/sync/SyncBadge'
import { InAppBrowserNotice } from './components/system/InAppBrowserNotice'
import { watchPosition } from './lib/geo'
import { Login } from './screens/Login'
import { Today } from './screens/Today'
import { Overview } from './screens/Overview'
import { MapScreen } from './screens/MapScreen'
import { Leads } from './screens/Leads'
import { Pipeline } from './screens/Pipeline'
import { PropertyDetail } from './screens/PropertyDetail'
import { VisitMode } from './screens/VisitMode'
import { RouteScreen } from './screens/RouteScreen'
import { More } from './screens/More'
import { NewLead } from './screens/NewLead'
import { StreetScreen } from './screens/StreetScreen'
import { Navigate as NavigateScreen } from './screens/Navigate'
import { ScheduleNew } from './screens/ScheduleNew'
import { Team } from './screens/Team'
import { Standings } from './screens/Standings'
import { RepDetail } from './screens/RepDetail'
import { Lists } from './screens/Lists'
import { ListDetail } from './screens/ListDetail'
import * as db from './lib/db'
import { TOUR_KEY } from './data/tour'
import { Tour } from './components/system/Tour'
import { Onboarding } from './onboarding/Onboarding'
import { MyBadge } from './screens/MyBadge'
import { MyProfile } from './screens/MyProfile'

/**
 * The office console is lazy-loaded.
 *
 * It's desktop-only and a field rep never opens it, so shipping its tables,
 * charts and reporting code in the main bundle would put ~10KB gzipped of dead
 * weight on every phone, on cellular, every cold start. This keeps it off the
 * field-rep critical path entirely.
 */
const AdminLayout = lazy(() =>
  import('./admin/AdminLayout').then((m) => ({ default: m.AdminLayout })),
)
const AdminDashboard = lazy(() =>
  import('./admin/AdminDashboard').then((m) => ({ default: m.AdminDashboard })),
)
const AdminReports = lazy(() =>
  import('./admin/AdminReports').then((m) => ({ default: m.AdminReports })),
)
const AdminTeam = lazy(() => import('./admin/AdminTeam').then((m) => ({ default: m.AdminTeam })))
const AdminTerritories = lazy(() =>
  import('./admin/AdminTerritories').then((m) => ({ default: m.AdminTerritories })),
)
const AdminLists = lazy(() => import('./admin/AdminLists').then((m) => ({ default: m.AdminLists })))
const AdminImport = lazy(() => import('./admin/AdminImport'))
const AdminAudit = lazy(() => import('./admin/AdminAudit'))
const AdminLeads = lazy(() => import('./admin/AdminLeads'))
const AdminSettings = lazy(() =>
  import('./admin/AdminSettings').then((m) => ({ default: m.AdminSettings })),
)
const AdminClients = lazy(() =>
  import('./admin/AdminClients').then((m) => ({ default: m.AdminClients })),
)

export function App() {
  const { ready, user, mode, boot, setPosition } = useAppStore()
  const location = useLocation()

  useEffect(() => {
    void boot()
  }, [boot])

  // One shared position watcher for the whole app. Multiple watchers is the
  // fastest way to flatten a phone battery over an eight-hour shift.
  useEffect(() => {
    if (!user) return
    return watchPosition(setPosition)
  }, [user, setPosition])

  // Keep the layout pinned to the *visible* viewport. On iOS the URL bar and
  // the software keyboard both change it, and 100vh doesn't notice either.
  useEffect(() => {
    const vv = window.visualViewport
    if (!vv) return
    const apply = () =>
      document.documentElement.style.setProperty('--app-h', `${vv.height}px`)
    apply()
    vv.addEventListener('resize', apply)
    return () => vv.removeEventListener('resize', apply)
  }, [])

  if (!ready) return <Splash />
  if (!user) return <Login />

  /*
    Onboarding owns the whole viewport until the server says it is complete.

    Keyed on what the server said about this person, and only when it said
    anything: a session cached before the field existed, a bootstrap mock, and
    the demo all carry no `onboarding`, and absent means "nothing to do". An
    upgrade must never throw a working rep into a flow they finished under
    another name, and the demo has no server to finish it against.
  */
  if (mode === 'live' && user.onboarding && user.onboarding.status !== 'complete') {
    return <Onboarding />
  }

  const isRep = user.role === 'field_rep'
  // Visit Mode owns the whole viewport — it renders its own shell.
  const immersive = /^\/visit\//.test(location.pathname)
  // The console renders its own nav and needs the full width.
  const inConsole = /^\/admin/.test(location.pathname)

  if (immersive) {
    return (
      <Routes>
        <Route path="/visit/:visitId" element={<VisitMode />} />
      </Routes>
    )
  }

  return (
    <div className="app-shell">
      <InAppBrowserNotice />
      <OfflineBanner />
      <div className="flex min-h-0 flex-1">
        {!inConsole && <SideRail role={user.role} />}
        {/*
          `min-w-0` is load-bearing, not tidiness: without it a flex item's
          floor is its content's min-content width, and one horizontally
          scrolling filter rail on the Leads header was stretching this pane to
          857px inside a 390px viewport. The app shell clips overflow, so nothing
          looked broken — the right-hand side of every list row, lead score
          included, was simply rendered off-screen where no viewport audit that
          measures document scrollWidth can see it.
        */}
        <main className="flex min-h-0 min-w-0 flex-1 flex-col">
          <Routes>
            <Route
              path="/today"
              element={isRep ? <Today /> : <Overview role={user.role} />}
            />
            <Route path="/map" element={<MapScreen />} />
            {/*
              Its own route rather than a mode of the map, so it can be linked,
              restored on reload and reached from the segmented control on
              either side. See StreetScreen.
            */}
            <Route path="/street" element={<StreetScreen />} />
            <Route path="/leads" element={<Leads />} />
            <Route path="/lists" element={<Lists />} />
            <Route path="/lists/:listId" element={<ListDetail />} />
            <Route path="/pipeline" element={<Pipeline />} />
            <Route path="/route" element={<RouteScreen />} />
            <Route path="/property/:propertyId" element={<PropertyDetail />} />
            <Route path="/lead/new" element={<NewLead />} />
            <Route path="/navigate/:id" element={<NavigateScreen />} />
            <Route path="/schedule/new" element={<ScheduleNew />} />
            <Route path="/team" element={<Team />} />
            {/* Everyone, reps included — the standings are the point of the thing. */}
            <Route path="/standings" element={<Standings />} />
            {/* A rep's own day, or anyone's for the office. Gated inside. */}
            <Route path="/rep/:repId" element={<RepDetail />} />
            <Route path="/more" element={<More />} />
            <Route path="/badge" element={<MyBadge />} />
            <Route path="/profile" element={<MyProfile />} />
            {/* Office console — desktop-first, role-gated inside the layout. */}
            <Route
              path="/admin"
              element={
                <Suspense fallback={<ConsoleLoading />}>
                  <AdminLayout />
                </Suspense>
              }
            >
              <Route index element={<AdminDashboard />} />
              <Route path="reports" element={<AdminReports />} />
              <Route path="team" element={<AdminTeam />} />
              <Route path="leads" element={<AdminLeads />} />
              <Route path="territories" element={<AdminTerritories />} />
              <Route path="lists" element={<AdminLists />} />
              <Route path="import" element={<AdminImport />} />
              <Route path="audit" element={<AdminAudit />} />
              <Route path="settings" element={<AdminSettings />} />
              <Route path="clients" element={<AdminClients />} />
            </Route>
            <Route path="*" element={<Navigate to="/today" replace />} />
          </Routes>
        </main>
      </div>
      {/*
        Everyone, not just reps. The office adds leads and books appointments
        from a phone too, and until now had no way to do either without first
        navigating to the right screen. The sheet's contents are chosen by role
        — see QuickActions.
      */}
      {!inConsole && <QuickActions />}
      {!inConsole && <BottomNav role={user.role} />}
      {/*
        The tour lives in the shell, not on a screen.

        It walks the app — map, leads, pipeline, the console — so it navigates,
        and anything mounted inside a route unmounts itself the moment it does.
        The first version was rendered by Today and killed itself on its own
        fifth step.
      */}
      <FirstRunTour />
    </div>
  )
}

/**
 * Opens the tour on a device that has not seen this version of it, once.
 *
 * The delay is not decoration: the first step measures a card that is rendered
 * from IndexedDB, and a spotlight cut before layout lands is a hole in the wrong
 * place — briefly, and exactly once, on the run where a wrong first impression
 * costs the most.
 */
function FirstRunTour() {
  const [open, setOpen] = useState(false)
  const requested = useAppStore((s) => s.tourRequest)

  useEffect(() => {
    let alive = true
    void (async () => {
      const seen = await db.metaGet<boolean>(TOUR_KEY)
      if (!seen && alive) window.setTimeout(() => alive && setOpen(true), 600)
    })()
    return () => {
      alive = false
    }
  }, [])

  /*
    Asked for from the More screen. Skipped at 0 so this does not fire on mount
    and race the check above into opening the tour twice.
  */
  useEffect(() => {
    if (requested > 0) setOpen(true)
  }, [requested])

  if (!open) return null
  return (
    <Tour
      onClose={() => {
        setOpen(false)
        // Skipping counts. Someone who skipped chose not to see it, and showing
        // it again tomorrow is the app overruling them.
        void db.metaSet(TOUR_KEY, true)
      }}
    />
  )
}

function ConsoleLoading() {
  return (
    <div className="grid flex-1 place-items-center p-10 text-sm text-ink-mute">
      Loading console…
    </div>
  )
}

function Splash() {
  return (
    <div className="app-shell items-center justify-center bg-ink text-white">
      <div className="flex flex-1 flex-col items-center justify-center gap-4">
        <span className="grid h-16 w-16 place-items-center rounded-card bg-brand-400 text-2xl font-black">
          A
        </span>
        <p className="text-sm text-ink-mute">Loading your territory…</p>
      </div>
    </div>
  )
}
