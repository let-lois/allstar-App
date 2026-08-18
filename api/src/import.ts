import type { Env, Role, SessionUser } from './types'

/**
 * Lead import.
 *
 * A field-sales tenant starts empty, and typing a territory in one address at a
 * time isn't a product. This takes the file a company already has — a vendor
 * list, a county export, a spreadsheet a manager built — and turns it into
 * properties a rep can knock.
 *
 * The design decision that matters here is **deterministic ids**. A property's id
 * is derived from its address within the tenant, so:
 *
 *   - re-running the same import changes nothing
 *   - importing a refreshed file from the same vendor updates in place
 *   - a double-submitted form can't double a territory
 *
 * Idempotency by construction, rather than by a ledger that has to be consulted
 * and kept clean. Imports get re-run — someone's connection drops halfway, or a
 * manager isn't sure the first one worked — and "just do it again" has to be the
 * correct answer.
 */

export const MAX_IMPORT_ROWS = 500

export interface ImportRow {
  /** The client's row reference, echoed back so errors point at a line number. */
  ref: string
  address1?: string
  city?: string
  state?: string
  zip?: string
  lat?: number
  lng?: number
  ownerName?: string
  phone?: string
  email?: string
  opportunityValue?: number
  roofAgeYears?: number
  squareFeet?: number
  notes?: string
}

export interface ImportInput {
  rows: ImportRow[]
  /** Optional: assign every imported lead to this rep. */
  assignRepId?: string
  /** Optional: group them under a named territory, created if it doesn't exist. */
  territoryName?: string
}

export interface ImportResult {
  created: number
  updated: number
  rejected: { ref: string; reason: string }[]
  territoryId?: string
}

const IMPORT_ROLES: Role[] = ['super_admin', 'client_admin', 'manager']

export function canImport(user: SessionUser): boolean {
  return IMPORT_ROLES.includes(user.role)
}

/**
 * The dedupe key. Case, punctuation and the usual street-type abbreviations are
 * folded, because the same house arrives as "1420 Cedar Bend Dr.", "1420 CEDAR
 * BEND DRIVE" and "1420 Cedar Bend Dr" across three files, and importing it
 * three times means three reps knock on it.
 */
export function addressKey(row: ImportRow): string {
  const parts = [row.address1, row.city, row.state, row.zip]
    .map((s) => (s ?? '').toString().toLowerCase())
    .join(' ')
  return parts
    .replace(/[.,#]/g, ' ')
    .replace(/\b(street|str)\b/g, 'st')
    .replace(/\b(avenue|ave)\b/g, 'av')
    .replace(/\b(drive|dr)\b/g, 'dr')
    .replace(/\b(road|rd)\b/g, 'rd')
    .replace(/\b(lane|ln)\b/g, 'ln')
    .replace(/\b(court|ct)\b/g, 'ct')
    .replace(/\b(circle|cir)\b/g, 'cir')
    .replace(/\b(boulevard|blvd)\b/g, 'blvd')
    .replace(/\b(place|pl)\b/g, 'pl')
    .replace(/\b(trail|trl)\b/g, 'trl')
    .replace(/\b(parkway|pkwy)\b/g, 'pkwy')
    .replace(/\b(north|n)\b/g, 'n')
    .replace(/\b(south|s)\b/g, 's')
    .replace(/\b(east|e)\b/g, 'e')
    .replace(/\b(west|w)\b/g, 'w')
    .replace(/\s+/g, ' ')
    .trim()
}

async function sha256Hex(text: string): Promise<string> {
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text))
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('')
}

/** Deterministic, tenant-scoped, and not guessable from the address alone. */
export async function propertyIdFor(clientId: string, row: ImportRow): Promise<string> {
  return `p_${(await sha256Hex(`${clientId}:${addressKey(row)}`)).slice(0, 24)}`
}

/**
 * Latitude and longitude are validated separately and strictly.
 *
 * A swapped pair is the single most damaging import bug: it doesn't error, it
 * silently relocates a Texas territory into the Indian Ocean, and the first
 * person to find out is a rep whose map is empty. Longitudes beyond ±90 are the
 * tell, so a value that can only be a longitude is refused in the latitude slot.
 */
function coord(v: unknown, kind: 'lat' | 'lng'): number | null {
  const n = typeof v === 'number' ? v : typeof v === 'string' ? Number(v) : NaN
  if (!Number.isFinite(n) || n === 0) return null
  const limit = kind === 'lat' ? 90 : 180
  if (Math.abs(n) > limit) return null
  return n
}

export async function importProperties(
  env: Env,
  user: SessionUser,
  input: ImportInput,
): Promise<ImportResult | { error: string; status: number }> {
  const rows = Array.isArray(input.rows) ? input.rows : []
  if (rows.length === 0) return { error: 'Nothing to import.', status: 400 }
  if (rows.length > MAX_IMPORT_ROWS) {
    return { error: `Too many rows; send at most ${MAX_IMPORT_ROWS}.`, status: 413 }
  }

  // An assignment has to be a real rep in *this* tenant. Accepting an arbitrary
  // id here would let an admin hand their leads to another company's user.
  let assignRepId: string | null = null
  if (input.assignRepId) {
    const rep = await env.DB.prepare(
      'SELECT id FROM users WHERE id = ?1 AND client_id = ?2 AND active = 1',
    )
      .bind(input.assignRepId, user.clientId)
      .first<{ id: string }>()
    if (!rep) return { error: 'That rep is not on this team.', status: 400 }
    assignRepId = rep.id
  }

  let territoryId: string | undefined
  if (input.territoryName?.trim()) {
    const name = input.territoryName.trim()
    const existing = await env.DB.prepare(
      'SELECT id FROM territories WHERE client_id = ?1 AND lower(name) = lower(?2)',
    )
      .bind(user.clientId, name)
      .first<{ id: string }>()
    if (existing) {
      territoryId = existing.id
    } else {
      territoryId = `terr_${(await sha256Hex(`${user.clientId}:${name.toLowerCase()}`)).slice(0, 16)}`
      await env.DB.prepare(
        `INSERT OR IGNORE INTO territories (id, client_id, name, rep_id) VALUES (?1,?2,?3,?4)`,
      )
        .bind(territoryId, user.clientId, name, assignRepId)
        .run()
    }
  }

  const rejected: ImportResult['rejected'] = []
  const now = Date.now()

  // Prepared once and reused: D1 charges per statement, and a 500-row import is
  // 500 of them.
  const upsert = env.DB.prepare(
    `INSERT INTO properties
       (id, client_id, address1, city, state, zip, lat, lng, status, score,
        opportunity_value, roof_age_years, square_feet, territory_id,
        assigned_rep_id, updated_at)
     VALUES (?1,?2,?3,?4,?5,?6,?7,?8,'new',?9,?10,?11,?12,?13,?14,?15)
     ON CONFLICT(id) DO UPDATE SET
       -- A re-import refreshes the list's own facts and leaves the field's work
       -- alone: status, last outcome and next action are the rep's, not the
       -- spreadsheet's, and a refreshed vendor file must never reset a lead
       -- that's already sold.
       city = COALESCE(excluded.city, properties.city),
       state = COALESCE(excluded.state, properties.state),
       zip = COALESCE(excluded.zip, properties.zip),
       lat = CASE WHEN excluded.lat != 0 THEN excluded.lat ELSE properties.lat END,
       lng = CASE WHEN excluded.lng != 0 THEN excluded.lng ELSE properties.lng END,
       opportunity_value = COALESCE(excluded.opportunity_value, properties.opportunity_value),
       roof_age_years = COALESCE(excluded.roof_age_years, properties.roof_age_years),
       square_feet = COALESCE(excluded.square_feet, properties.square_feet),
       territory_id = COALESCE(excluded.territory_id, properties.territory_id),
       assigned_rep_id = COALESCE(excluded.assigned_rep_id, properties.assigned_rep_id),
       updated_at = excluded.updated_at`,
  )

  const statements: D1PreparedStatement[] = []
  const ids: string[] = []
  const seen = new Set<string>()

  for (const row of rows) {
    const address1 = (row.address1 ?? '').toString().trim()
    if (!address1) {
      rejected.push({ ref: row.ref, reason: 'No street address' })
      continue
    }

    const key = addressKey(row)
    // Duplicates *within one file* are common — a vendor list with a row per
    // parcel owner repeats the address. Collapse them here rather than letting
    // the last one silently win.
    if (seen.has(key)) {
      rejected.push({ ref: row.ref, reason: 'Duplicate of an earlier row in this file' })
      continue
    }
    seen.add(key)

    const id = await propertyIdFor(user.clientId, row)
    ids.push(id)

    statements.push(
      upsert.bind(
        id,
        user.clientId,
        address1,
        row.city?.trim() || null,
        row.state?.trim() || null,
        row.zip?.trim() || null,
        coord(row.lat, 'lat') ?? 0,
        coord(row.lng, 'lng') ?? 0,
        50,
        Number.isFinite(row.opportunityValue as number) ? row.opportunityValue : null,
        Number.isFinite(row.roofAgeYears as number) ? row.roofAgeYears : null,
        Number.isFinite(row.squareFeet as number) ? row.squareFeet : null,
        territoryId ?? null,
        assignRepId,
        now,
      ),
    )

    if (row.ownerName?.trim()) {
      statements.push(
        env.DB.prepare(
          `INSERT OR REPLACE INTO contacts
             (id, property_id, name, phone, email, relationship, is_primary)
           VALUES (?1,?2,?3,?4,?5,'owner',1)`,
        ).bind(
          `ct_${id.slice(2)}`,
          id,
          row.ownerName.trim(),
          row.phone?.trim() || null,
          row.email?.trim() || null,
        ),
      )
    }
  }

  if (statements.length === 0) {
    return { created: 0, updated: 0, rejected, territoryId }
  }

  // Which ids already existed, asked *before* the write — afterwards there is no
  // way to tell a create from an update, and "created 400" vs "updated 400" is
  // the difference between a successful import and a no-op the operator needs to
  // know about.
  const existingBefore = await countExisting(env, user.clientId, ids)

  await env.DB.batch(statements)

  const total = ids.length
  return {
    created: total - existingBefore,
    updated: existingBefore,
    rejected,
    territoryId,
  }
}

/** Chunked because SQLite caps bound parameters per statement. */
async function countExisting(env: Env, clientId: string, ids: string[]): Promise<number> {
  let found = 0
  for (let i = 0; i < ids.length; i += 100) {
    const chunk = ids.slice(i, i + 100)
    const placeholders = chunk.map((_, n) => `?${n + 2}`).join(',')
    const res = await env.DB.prepare(
      `SELECT COUNT(*) AS n FROM properties WHERE client_id = ?1 AND id IN (${placeholders})`,
    )
      .bind(clientId, ...chunk)
      .first<{ n: number }>()
    found += res?.n ?? 0
  }
  return found
}
