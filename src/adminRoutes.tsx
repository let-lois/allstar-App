/**
 * The office console's routes, lazy-loaded — the browser's half.
 *
 * Each screen is its own chunk, fetched the first time somebody opens the
 * console, so a rep's browser never downloads 8,575 lines of desktop tables,
 * the territory lasso and the CSV importer it has no route to.
 *
 * The phone app cannot load them this way. Metro follows a dynamic `import()`
 * into a chunk instead of leaving it on a server, and `expo export` failed on
 * the shared chunk these eleven produced. So `apps/mobile/metro.config.js`
 * swaps this file for `apps/mobile/src/admin-routes-native.tsx`, which imports
 * the same screens statically. The route table itself is shared — see
 * `admin/routeTree.tsx` — so the two cannot drift.
 *
 * The console is role-gated inside `AdminLayout`, and every API it calls is
 * gated again on the Worker.
 */
import { lazy } from 'react'
import { adminRouteTree } from './admin/routeTree'

const screens = {
  AdminLayout: lazy(() => import('./admin/AdminLayout').then((m) => ({ default: m.AdminLayout }))),
  AdminDashboard: lazy(() => import('./admin/AdminDashboard').then((m) => ({ default: m.AdminDashboard }))),
  AdminReports: lazy(() => import('./admin/AdminReports').then((m) => ({ default: m.AdminReports }))),
  AdminTeam: lazy(() => import('./admin/AdminTeam').then((m) => ({ default: m.AdminTeam }))),
  AdminTerritories: lazy(() => import('./admin/AdminTerritories').then((m) => ({ default: m.AdminTerritories }))),
  AdminLists: lazy(() => import('./admin/AdminLists').then((m) => ({ default: m.AdminLists }))),
  AdminImport: lazy(() => import('./admin/AdminImport')),
  AdminAudit: lazy(() => import('./admin/AdminAudit')),
  AdminLeads: lazy(() => import('./admin/AdminLeads')),
  AdminSettings: lazy(() => import('./admin/AdminSettings').then((m) => ({ default: m.AdminSettings }))),
  AdminClients: lazy(() => import('./admin/AdminClients').then((m) => ({ default: m.AdminClients }))),
}

export function adminRoutes() {
  return adminRouteTree(screens)
}
