/**
 * The office console's routes, in their own module so a phone never carries them.
 *
 * These were eleven `lazy()` calls and a `<Route>` tree inside `App.tsx`, and
 * lazy-loading was enough while there was one bundler. There are two now: the
 * native app wraps this same web app in a DOM component, and Metro follows a
 * dynamic `import()` into the bundle instead of leaving it on a server to be
 * fetched on demand. A phone would carry all 8,575 lines of desktop console —
 * wide tables, the territory lasso, the CSV importer — inside an app with no
 * route to reach them by.
 *
 * So the seam is a module boundary now rather than a call. `apps/mobile`
 * replaces this file with a stub that renders nothing, which is also what
 * removes the last of the dynamic imports from the DOM bundle; see
 * `apps/mobile/metro.config.js`.
 *
 * On the web nothing changes: same components, same `lazy()`, same chunks, and
 * the console is still role-gated inside `AdminLayout` rather than here.
 */
import { Suspense, lazy } from 'react'
import { Route } from 'react-router-dom'

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

function ConsoleLoading() {
  return (
    <div className="grid flex-1 place-items-center p-10 text-sm text-ink-mute">
      Loading console…
    </div>
  )
}

/**
 * A fragment of `<Route>` elements, returned rather than rendered.
 *
 * `<Routes>` reads its children as configuration, so a component wrapping
 * these would be invisible to the router and the routes would simply not
 * exist. Calling a function that returns them keeps them direct children.
 */
export function adminRoutes() {
  return (
    <>
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
    </>
  )
}
