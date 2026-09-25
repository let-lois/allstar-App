import { Suspense, type ComponentType } from 'react'
import { Route } from 'react-router-dom'

/**
 * The office console's route table — one table, two ways of loading it.
 *
 * The web app lazy-loads each screen (`src/adminRoutes.tsx`), so a browser
 * fetches the console only when someone opens it. The phone app cannot: Metro
 * follows a dynamic `import()` into a shared chunk, and `expo export` could not
 * serialise the one eleven of them produced — which is why the console was
 * stubbed out of the native bundle entirely. The phone therefore imports the
 * same screens statically (`apps/mobile/src/admin-routes-native.tsx`).
 *
 * Both hand their screens to this function, so the paths, the nesting and the
 * role gate are written once. A section added here reaches the browser and the
 * phone together; there is no second console to forget.
 *
 * The role gate is not here on purpose. It lives inside `AdminLayout`, which
 * every one of these routes renders through, and the Worker enforces the same
 * roles again on every API call the screens make — hiding a route is never the
 * control.
 */
export interface AdminScreens {
  AdminLayout: ComponentType
  AdminDashboard: ComponentType
  AdminReports: ComponentType
  AdminTeam: ComponentType
  AdminLeads: ComponentType
  AdminTerritories: ComponentType
  AdminLists: ComponentType
  AdminImport: ComponentType
  AdminAudit: ComponentType
  AdminSettings: ComponentType
  AdminClients: ComponentType
}

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
 *
 * The Suspense boundary is harmless for statically imported screens — nothing
 * suspends — and required for lazy ones.
 */
export function adminRouteTree(s: AdminScreens) {
  return (
    <>
      {/* Office console — role-gated inside the layout, on every surface. */}
      <Route
        path="/admin"
        element={
          <Suspense fallback={<ConsoleLoading />}>
            <s.AdminLayout />
          </Suspense>
        }
      >
        <Route index element={<s.AdminDashboard />} />
        <Route path="reports" element={<s.AdminReports />} />
        <Route path="team" element={<s.AdminTeam />} />
        <Route path="leads" element={<s.AdminLeads />} />
        <Route path="territories" element={<s.AdminTerritories />} />
        <Route path="lists" element={<s.AdminLists />} />
        <Route path="import" element={<s.AdminImport />} />
        <Route path="audit" element={<s.AdminAudit />} />
        <Route path="settings" element={<s.AdminSettings />} />
        <Route path="clients" element={<s.AdminClients />} />
      </Route>
    </>
  )
}
