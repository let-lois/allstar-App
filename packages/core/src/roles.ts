import type { Role } from './types'

/**
 * Which roles a person may hand out.
 *
 * Mirrors `grantableRoles` on the server, and is deliberately only a mirror: the
 * server refuses regardless, because a list rendered in a browser is a
 * convenience and never a boundary. What this buys is that an admin is not shown
 * an option that will be rejected the moment they use it.
 */
export function grantableRoles(actor: { role: Role } | null | undefined): Role[] {
  if (actor?.role === 'super_admin')
    return ['field_rep', 'manager', 'client_admin', 'super_admin']
  if (actor?.role === 'client_admin') return ['field_rep', 'manager', 'client_admin']
  return []
}

export const ROLE_BLURB: Record<Role, string> = {
  field_rep: 'Route, map and visits on their phone',
  manager: 'Team activity and reporting, plus the field app',
  client_admin: 'Everything, including the team and settings',
  super_admin: 'Everything, plus other super admins and the platform sections',
}

export const ROLE_LABEL: Record<Role, string> = {
  field_rep: 'Field Rep',
  manager: 'Manager',
  client_admin: 'Client Admin',
  super_admin: 'Super Admin',
}
