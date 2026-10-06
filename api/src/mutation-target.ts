import type { Mutation } from './types'

/**
 * Which lead a queued mutation is about.
 *
 * Every kind that touches a property names it as `propertyId`, except
 * `property.status`, which names it as `id` because the mutation *is* the
 * property. Two callers need this — the tombstone check that stops a phone
 * undoing an erasure, and the staleness check — so it lives in one place rather
 * than being re-derived, slightly differently, in each.
 *
 * Returns an empty string for the kinds that are about a route, a user avatar or
 * a task with no lead attached. Callers treat that as "not about a property"
 * rather than as an error: it is the normal case for several kinds.
 */
export function propertyIdOf(m: Mutation): string {
  const p = (m.payload ?? {}) as Record<string, unknown>
  if (m.kind === 'property.status' || m.kind === 'property.plan') return typeof p.id === 'string' ? p.id : ''
  return typeof p.propertyId === 'string' ? p.propertyId : ''
}
