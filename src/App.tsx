import { Suspense, lazy, useEffect } from 'react'
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
import { ScheduleNew } from './screens/ScheduleNew'
import { Team } from './screens/Team'

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
const AdminImport = lazy(() => import('./admin/AdminImport'))
const AdminSettings = lazy(() =>
  import('./admin/AdminSettings').then((m) => ({ default: m.AdminSettings })),
)
const AdminClients = lazy(() =>
  import('./admin/AdminClients').then((m) => ({ default: m.AdminClients })),
)

export function App() {
  const { ready, user, boot, setPosition } = useAppStore()
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
        <main className="flex min-h-0 flex-1 flex-col">
          <Routes>
            <Route
              path="/today"
              element={isRep ? <Today /> : <Overview role={user.role} />}
            />
            <Route path="/map" element={<MapScreen />} />
            <Route path="/leads" element={<Leads />} />
            <Route path="/pipeline" element={<Pipeline />} />
            <Route path="/route" element={<RouteScreen />} />
            <Route path="/property/:propertyId" element={<PropertyDetail />} />
            <Route path="/lead/new" element={<NewLead />} />
            <Route path="/schedule/new" element={<ScheduleNew />} />
            <Route path="/team" element={<Team />} />
            <Route path="/more" element={<More />} />
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
              <Route path="territories" element={<AdminTerritories />} />
              <Route path="import" element={<AdminImport />} />
              <Route path="settings" element={<AdminSettings />} />
              <Route path="clients" element={<AdminClients />} />
            </Route>
            <Route path="*" element={<Navigate to="/today" replace />} />
          </Routes>
        </main>
      </div>
      {isRep && !inConsole && <QuickActions />}
      {!inConsole && <BottomNav role={user.role} />}
    </div>
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
        <span className="grid h-16 w-16 place-items-center rounded-2xl bg-brand-500 text-2xl font-black">
          A
        </span>
        <p className="text-sm text-slate-400">Loading your territory…</p>
      </div>
    </div>
  )
}
