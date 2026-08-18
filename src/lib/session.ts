import type { Role, User } from '../types'
import * as db from './db'
import type { SessionUserDTO } from './http'

/**
 * Who is signed in, and against what.
 *
 * Two modes, deliberately explicit rather than inferred:
 *
 *   demo — the seeded dataset, no server. This is the pitch. It has to keep
 *          working with no account, no signal and no backend at all.
 *   live — a real account on the API. A bearer token, a real tenant, and an
 *          outbox that drains to D1.
 *
 * The mode is stored next to the data it describes so a reload can't land in a
 * state where the app is reading demo properties while pushing them to a real
 * tenant. Mixing the two would be the worst possible bug in this app: a rep's
 * genuine knock recorded against a fictional address, or a prospect shown a
 * demo that quietly writes to production.
 */

export type SessionMode = 'demo' | 'live'

export interface DemoSession {
  mode: 'demo'
  userId: string
}

export interface LiveSession {
  mode: 'live'
  token: string
  user: User
}

export type Session = DemoSession | LiveSession

/**
 * A new key rather than reusing `allstar.session`, which held a bare userId
 * string. Anyone upgrading has that value on disk, and reading it as an object
 * would leave them signed in as `undefined`.
 */
const KEY = 'allstar.session.v2'

/**
 * Cached in memory as well as on disk. The outbox drains from a background
 * timer, where it needs the token synchronously — an await there would mean the
 * queue reads IndexedDB once per mutation.
 */
let current: Session | null = null

/**
 * Whether the session has been read off disk yet.
 *
 * Tracked separately from `current` because "no session" and "we haven't looked
 * yet" are different answers, and conflating them cost a rep their whole day:
 * the outbox drains on start-up, and if that happens before the session is
 * known, `isDemo()` says yes, the demo simulator marks every queued mutation
 * applied, and the queue deletes work that never left the phone.
 *
 * Nothing throws. The rep just finds their morning gone.
 */
let loaded = false

export function currentSession(): Session | null {
  return current
}

export function sessionKnown(): boolean {
  return loaded
}

/**
 * True only when we know we're in demo mode. Before the session is read this is
 * false, so callers fall through to the "can't act yet" path rather than
 * defaulting into the simulator.
 */
export function isDemo(): boolean {
  return loaded && current?.mode !== 'live'
}

export function liveToken(): string | null {
  return current?.mode === 'live' ? current.token : null
}

export async function loadSession(): Promise<Session | null> {
  const saved = await db.metaGet<Session>(KEY)
  loaded = true
  // Defensive: a half-written record is worse than no session, because it would
  // put the app in live mode without a token and 401 every write.
  if (saved?.mode === 'live' && typeof saved.token === 'string' && saved.user) current = saved
  else if (saved?.mode === 'demo' && typeof saved.userId === 'string') current = saved
  else current = null
  return current
}

export async function saveSession(s: Session): Promise<void> {
  current = s
  loaded = true
  await db.metaSet(KEY, s)
}

export async function clearSession(): Promise<void> {
  current = null
  loaded = true
  await db.metaSet(KEY, undefined)
}

/**
 * The token expired or was revoked while the app was in someone's pocket.
 *
 * Handled as an event rather than by throwing at the call site, because the
 * discovery almost always happens inside a background drain where there is no
 * screen to show an error on. The rep's queued work is deliberately left in the
 * outbox — it drains after they sign in again.
 */
type ExpiryListener = () => void
let expiryListeners: ExpiryListener[] = []

export function onAuthExpired(fn: ExpiryListener): () => void {
  expiryListeners.push(fn)
  return () => {
    expiryListeners = expiryListeners.filter((f) => f !== fn)
  }
}

export function signalAuthExpired(): void {
  expiryListeners.forEach((f) => f())
}

/** Initials for the avatar — the server sends a name, not a monogram. */
export function initialsOf(name: string): string {
  const parts = name.trim().split(/\s+/).filter(Boolean)
  if (parts.length === 0) return '?'
  if (parts.length === 1) return parts[0].slice(0, 2).toUpperCase()
  return (parts[0][0] + parts[parts.length - 1][0]).toUpperCase()
}

export function userFromDTO(dto: SessionUserDTO): User {
  return {
    id: dto.id,
    name: dto.name,
    role: dto.role as Role,
    clientId: dto.clientId,
    clientName: dto.clientName,
    avatarInitials: initialsOf(dto.name),
    phone: dto.phone,
    email: dto.email,
  }
}
