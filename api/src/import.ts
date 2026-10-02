import { record } from './audit'
import { bindChunks } from './d1'
import { parseBoundary, polygonAreaSqMiles, territoryFor, type TerritoryShape } from './geo'
import { erasedAmong } from './erase'
import type { Env, Role, SessionUser } from './types'
import { territoryRepStatements } from './territory-reps'

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

/** What a geocoder is allowed to claim about a pin. Anything else is null. */
const PRECISIONS = new Set(['rooftop', 'interpolated', 'approximate'])

export interface ImportRow {
  /** The client's row reference, echoed back so errors point at a line number. */
  ref: string
  address1?: string
  city?: string
  state?: string
  zip?: string
  lat?: number
  lng?: number
  /**
   * How well the coordinates above are known, as the geocoder reported it.
   *
   * Sent by the importer rather than recomputed here, because the geocoding
   * already happened: the preview step calls `/api/import/geocode`, shows the
   * operator which rows were guessed, and then posts the rows it was given. The
   * precision was in that answer and was being dropped on this boundary — so
   * the app knew which houses it was estimating and forgot before saving.
   */
  precision?: 'rooftop' | 'interpolated' | 'approximate'
  /** Which geocoder said so. "According to whom" is the next question. */
  geoProvider?: string
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
  /** This request made the named territory (no outline: a named group of these leads). */
  territoryCreated?: boolean
  /**
   * How many leads landed in a drawn territory by their coordinates.
   *
   * Reported because the alternative is an operator who cannot tell the
   * difference between "every lead found its patch" and "no territory has a
   * boundary yet" — both look like a successful import, and only one of them
   * leaves somebody a day of manual assignment.
   */
  territoryMatched?: number
  /** Leads with usable coordinates that fell inside no drawn territory. */
  territoryUnmatched?: number
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
  let newTerritory: { id: string; name: string } | null = null
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
      /*
        A new territory with this name and no outline — a named group of these
        leads, to find and reassign as a unit — created in the same batch as
        the rows below, so an import that writes nothing (every row rejected, or
        a failure) leaves no empty territory behind in the filters.

        The id is derived from the name so the next chunk of the same file
        lands in the same territory. Unless that id is taken: a territory first
        imported as "North" and since renamed keeps the id, and a later import
        naming "North" again must make a new one, not pour its rows silently
        into the renamed patch.
      */
      const derived = `terr_${(await sha256Hex(`${user.clientId}:${name.toLowerCase()}`)).slice(0, 16)}`
      const taken = await env.DB.prepare('SELECT id FROM territories WHERE id = ?1').bind(derived).first<{ id: string }>()
      territoryId = taken ? `terr_${crypto.randomUUID().replace(/-/g, '').slice(0, 16)}` : derived
      newTerritory = { id: territoryId, name }
    }
  }

  /*
    The drawn territories, loaded once.

    Only when the operator did not name one: an explicit choice is an explicit
    choice, and quietly overriding it with geometry would make the field on the
    import screen a suggestion. Skipped entirely when there are no shapes, which
    is every account until somebody draws a patch — the query is cheap but the
    honest reason is that `matched` should read zero because nothing was drawn,
    not because nothing matched.
  */
  let shapes: TerritoryShape[] = []
  if (!territoryId) {
    const drawn = await env.DB.prepare(
      'SELECT id, rep_id, boundary FROM territories WHERE client_id = ?1 AND boundary IS NOT NULL',
    )
      .bind(user.clientId)
      .all()
    for (const t of drawn.results as Record<string, unknown>[]) {
      const boundary = parseBoundary(t.boundary)
      if (!boundary) continue
      shapes.push({
        id: String(t.id),
        repId: t.rep_id == null ? null : String(t.rep_id),
        boundary,
        areaSqMiles: polygonAreaSqMiles(boundary),
      })
    }
  }

  const rejected: ImportResult['rejected'] = []
  let territoryMatched = 0
  let territoryUnmatched = 0
  const now = Date.now()

  // Prepared once and reused: D1 charges per statement, and a 500-row import is
  // 500 of them.
  const upsert = env.DB.prepare(
    `INSERT INTO properties
       (id, client_id, address1, city, state, zip, lat, lng, status, score,
        opportunity_value, roof_age_years, square_feet, territory_id,
        assigned_rep_id, geo_precision, geo_provider, updated_at)
     VALUES (?1,?2,?3,?4,?5,?6,?7,?8,'new',?9,?10,?11,?12,?13,?14,?16,?17,?15)
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
       -- Precision travels with the coordinates it describes, under the same
       -- condition. A re-import carrying no coordinates keeps the old pin, so it
       -- has to keep the old pin's precision too — taking the new file's null
       -- there would erase what we knew about a lead nobody re-geocoded.
       geo_precision = CASE WHEN excluded.lat != 0
         THEN excluded.geo_precision ELSE properties.geo_precision END,
       geo_provider = CASE WHEN excluded.lat != 0
         THEN excluded.geo_provider ELSE properties.geo_provider END,
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

  /*
    Which of these addresses have been erased.

    Asked once for the whole file rather than per row: an import is a thousand
    rows and this is one query. It has to happen at all because a property's id
    is derived from its address, so a CSV containing an erased address would
    otherwise recreate the lead — an erasure undone by the next upload, silently,
    by somebody who had no idea they were doing it.
  */
  const erased = await erasedAmong(
    env,
    user.clientId,
    await Promise.all(rows.map((r) => propertyIdFor(user.clientId, r))),
  )

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

    /*
      Rejected rather than skipped, and named as a reason the operator sees. A
      row that silently vanished from an import would send somebody hunting for
      a parsing bug; "erased" tells them what actually happened and that it was
      deliberate.
    */
    if (erased.has(id)) {
      rejected.push({
        ref: row.ref,
        reason: 'This address was erased — importing it again would undo that',
      })
      continue
    }

    ids.push(id)

    /*
      Which patch does this lead fall in?

      Only consulted when the operator named no territory, and only for a lead
      that actually has coordinates — a row that failed to geocode has nothing
      to match, and counting it as unmatched would blame the territories for a
      missing address.

      The rep comes with the patch unless one was named for the whole file. This
      is the part that matters: a territory nobody is assigned to still leaves
      the lead unowned, but most drawn patches have a rep, and inheriting them is
      the difference between an import that is ready to work and one that needs a
      person to sit down with it.
    */
    const lat = coord(row.lat, 'lat')
    const lng = coord(row.lng, 'lng')
    let rowTerritoryId = territoryId ?? null
    let rowRepId = assignRepId
    if (!territoryId && lat != null && lng != null) {
      const match = shapes.length ? territoryFor({ lat, lng }, shapes) : null
      if (match) {
        rowTerritoryId = match.id
        if (!rowRepId) rowRepId = match.repId
        territoryMatched += 1
      } else {
        territoryUnmatched += 1
      }
    }

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
        rowTerritoryId,
        rowRepId,
        now,
        /*
          Validated against the three the geocoders can actually report rather
          than trusted from the request body. This value decides how confident
          the map looks about a house, so an importer that sent 'exact' or
          'rooftop!!' must not have that rendered as certainty — an unrecognised
          value becomes null, which the map reads as "unknown quality" and shows
          honestly.
        */
        PRECISIONS.has(String(row.precision)) ? String(row.precision) : null,
        row.geoProvider?.trim().slice(0, 40) || null,
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
    // Nothing written, so the named territory is not made either.
    return { created: 0, updated: 0, rejected, territoryId: newTerritory ? undefined : territoryId, territoryMatched, territoryUnmatched }
  }
  if (newTerritory) {
    // First in the batch: the rows reference it. `rep_id` is a mirror; who is on
    // a territory lives in territory_reps, written alongside.
    statements.unshift(
      env.DB.prepare(`INSERT OR IGNORE INTO territories (id, client_id, name, rep_id) VALUES (?1,?2,?3,?4)`).bind(
        newTerritory.id,
        user.clientId,
        newTerritory.name,
        assignRepId,
      ),
      ...(assignRepId ? territoryRepStatements(env, user, newTerritory.id, [assignRepId], Date.now()) : []),
    )
  }

  // Which ids already existed, asked *before* the write — afterwards there is no
  // way to tell a create from an update, and "created 400" vs "updated 400" is
  // the difference between a successful import and a no-op the operator needs to
  // know about.
  const existingBefore = await countExisting(env, user.clientId, ids)

  await env.DB.batch(statements)

  const total = ids.length
  const result = {
    created: total - existingBefore,
    updated: existingBefore,
    rejected,
    territoryId,
    /** Whether this request made the named territory (no outline; a group of these leads). */
    territoryCreated: !!newTerritory,
    territoryMatched,
    territoryUnmatched,
    /*
      Which leads this import wrote, so the console can offer to assign exactly
      them without guessing.

      Ids are minted here rather than by the caller, so without this the screen
      that knows somebody just imported 500 leads has no way to act on them —
      which is how 500 leads end up assigned to nobody, invisible on every
      phone, while the console reports a healthy import. Bounded already: the
      endpoint refuses more than MAX_IMPORT_ROWS per request, and the response
      is smaller than the request that produced it.
    */
    ids,
    /** How many of them nobody is going to see, unless something says so. */
    unassigned: assignRepId ? 0 : total,
  }

  await record(env, user, {
    action: 'leads.imported',
    targetType: 'import',
    targetId: territoryId,
    targetLabel: input.territoryName?.trim() || 'Unassigned',
    detail: {
      created: result.created,
      updated: result.updated,
      rejected: rejected.length,
      assignedTo: assignRepId,
      // In the audit log because "who owns these leads" is the question someone
      // asks weeks later, and a territory match is an assignment nobody typed.
      territoryMatched,
      territoryUnmatched,
    },
  })

  return result
}

/** Chunked because SQLite caps bound parameters per statement. */
async function countExisting(env: Env, clientId: string, ids: string[]): Promise<number> {
  let found = 0
  for (const chunk of bindChunks(ids, 1)) {
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
