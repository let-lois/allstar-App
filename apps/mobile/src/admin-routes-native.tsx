/**
 * The office console, in the phone app — the same screens, loaded statically.
 *
 * Metro swaps this in for the web app's `src/adminRoutes.tsx` when bundling
 * the DOM shell — see `metro.config.js`. It used to be a stub that returned
 * nothing, on the argument that the console was desktop software nobody would
 * open on a phone. Both halves stopped being true: the console's screens were
 * rebuilt for a 390px phone (cards instead of wide tables, sections as chips —
 * `verify:console-access`), and the people who run a crew test badges, team
 * members and a rep's photos from the phone in their pocket.
 *
 * What the stub actually protected against was a bundler, not a screen size.
 * The web file lazy-loads each screen with `import()`; Metro follows each one
 * into a chunk, and `expo export` could not serialise the shared chunk eleven
 * of them made. Importing them statically here gives Metro one module graph
 * and no chunks at all — the cost is that the console's code is in the phone
 * bundle whether or not it is opened, which is the trade the web half exists
 * to avoid and the phone, loading from disk, can afford.
 *
 * The route table is not repeated: it is `adminRouteTree`, the same function
 * the browser calls. Nor is the role gate — `AdminLayout` refuses a field rep
 * on every surface, and every API these screens call is gated again on the
 * Worker.
 */
import { adminRouteTree } from '@web/admin/routeTree'
import { AdminLayout } from '@web/admin/AdminLayout'
import { AdminDashboard } from '@web/admin/AdminDashboard'
import { AdminReports } from '@web/admin/AdminReports'
import { AdminTeam } from '@web/admin/AdminTeam'
import { AdminTerritories } from '@web/admin/AdminTerritories'
import { AdminLists } from '@web/admin/AdminLists'
import AdminImport from '@web/admin/AdminImport'
import AdminAudit from '@web/admin/AdminAudit'
import AdminLeads from '@web/admin/AdminLeads'
import { AdminSettings } from '@web/admin/AdminSettings'
import { AdminClients } from '@web/admin/AdminClients'

const screens = {
  AdminLayout,
  AdminDashboard,
  AdminReports,
  AdminTeam,
  AdminTerritories,
  AdminLists,
  AdminImport,
  AdminAudit,
  AdminLeads,
  AdminSettings,
  AdminClients,
}

export function adminRoutes() {
  return adminRouteTree(screens)
}
