import { record } from './audit'
import { canImport } from './import'
import type { Env, SessionUser } from './types'

/**
 * Leads out, as a spreadsheet.
 *
 * The office's end of the day: everything the reps entered, in one file that
 * opens in Excel or Sheets and can be handed to whoever asked for it. Every
 * lead once — a house on three lists is one row with three names in the
 * `lists` column, not three rows — with the contact, the rep it belongs to,
 * the lists it is on, and every note anyone left, newest last.
 *
 * ## Who may pull it
 *
 * The same office roles that may import: a rep's phone never needs a whole
 * tenant's leads in a file, and a file is the one shape of the data that leaves
 * the building. Decided here rather than at the route, so the rule travels
 * with the function that produces the file.
 *
 * ## What is written
 *
 * RFC 4180: a field is quoted when it holds a comma, a quote, or a line break,
 * and a quote inside is doubled. Notes are joined with a real newline inside
 * one quoted field, which every spreadsheet reads back as one cell. Free-text
 * fields that begin with `=`, `+`, `-` or `@` are prefixed with an apostrophe so
 * a note reading `=HYPERLINK(...)` opens as text, not as a formula; numbers
 * are not touched, because `-97.67` is a longitude and not an attack.
 */

export interface ExportFilter {
  listId?: string | null
  repId?: string | null
  status?: string | null
  /** A territory id, or 'none' for leads in no territory. */
  territoryId?: string | null
  /**
   * Exactly these leads, when given — the console's "Export selected" and
   * "Export all matching" (its search, visited, appointment and follow-up
   * filters live in the browser, so it sends the ids they produced). The other
   * filters still apply on top, and every id is checked against this tenant.
   */
  ids?: string[] | null
  /** What the file is of, for its name: "gaffney", "selected", a list name. */
  label?: string | null
}

/** At most this many ids in one export request (a whole company is a few thousand). */
export const MAX_EXPORT_IDS = 20000

export type ExportResult =
  | { ok: true; csv: string; rows: number; filename: string }
  | { ok: false; error: string; status: number }

export const EXPORT_COLUMNS = [
  'lead_id',
  'address',
  'city',
  'state',
  'zip',
  'lat',
  'lng',
  'status',
  'name',
  'phone',
  'email',
  'assigned_rep',
  'lists',
  'score',
  'opportunity_value',
  'last_outcome',
  'last_visit',
  'next_action',
  'notes',
  'first_activity',
  'updated',
] as const

/** D1 binds at most 100 parameters per statement; one is the tenant. */
const CHUNK = 90

const iso = (ms: unknown) => (typeof ms === 'number' && ms > 0 ? new Date(ms).toISOString() : '')

/** Quote when the field needs it, and only then, so plain files stay plain. */
export function csvField(value: unknown, text = false): string {
  let s = value === null || value === undefined ? '' : String(value)
  if (text && /^[=+\-@]/.test(s)) s = `'${s}`
  if (/[",\r\n]/.test(s) || /^\s|\s$/.test(s)) return `"${s.replace(/"/g, '""')}"`
  return s
}

async function inChunks<T>(
  env: Env,
  ids: string[],
  sql: (holes: string) => string,
  bindBefore: unknown[],
): Promise<T[]> {
  const out: T[] = []
  for (let i = 0; i < ids.length; i += CHUNK) {
    const chunk = ids.slice(i, i + CHUNK)
    const holes = chunk.map((_, n) => `?${n + 1 + bindBefore.length}`).join(',')
    const res = await env.DB.prepare(sql(holes))
      .bind(...bindBefore, ...chunk)
      .all<T>()
    out.push(...(res.results ?? []))
  }
  return out
}

export async function exportLeadsCsv(
  env: Env,
  actor: SessionUser,
  filter: ExportFilter,
): Promise<ExportResult> {
  if (!canImport(actor)) return { ok: false, error: 'Not permitted.', status: 403 }

  const listId = typeof filter.listId === 'string' && filter.listId ? filter.listId : null
  const repId = typeof filter.repId === 'string' && filter.repId ? filter.repId : null
  const status = typeof filter.status === 'string' && filter.status ? filter.status : null
  const territoryId = typeof filter.territoryId === 'string' && filter.territoryId ? filter.territoryId : null
  const pickIds = Array.isArray(filter.ids)
    ? [...new Set(filter.ids.filter((x): x is string => typeof x === 'string' && x.length > 0 && x.length <= 80))]
    : null
  if (pickIds && pickIds.length > MAX_EXPORT_IDS) {
    return { ok: false, error: `Export at most ${MAX_EXPORT_IDS.toLocaleString()} leads at a time.`, status: 413 }
  }

  /*
    The list, if named, must be this tenant's. Filtering through a list id from
    another company would return nothing anyway — the properties are scoped by
    client — but "nothing" and "no such list" are different answers, and the
    second one is the honest one.
  */
  let listName: string | null = null
  if (listId) {
    const l = await env.DB.prepare(`SELECT name FROM lead_lists WHERE id = ?1 AND client_id = ?2`)
      .bind(listId, actor.clientId)
      .first<{ name: string }>()
    if (!l) return { ok: false, error: 'No such list.', status: 404 }
    listName = l.name
  }

  const where = ['p.client_id = ?1']
  const binds: unknown[] = [actor.clientId]
  if (repId === 'unassigned') where.push('p.assigned_rep_id IS NULL')
  else if (repId) {
    binds.push(repId)
    where.push(`p.assigned_rep_id = ?${binds.length}`)
  }
  if (status) {
    binds.push(status)
    where.push(`p.status = ?${binds.length}`)
  }
  if (listId) {
    binds.push(listId)
    where.push(`p.id IN (SELECT property_id FROM lead_list_members WHERE list_id = ?${binds.length})`)
  }
  if (territoryId === 'none') where.push('p.territory_id IS NULL')
  else if (territoryId) {
    binds.push(territoryId)
    where.push(`p.territory_id = ?${binds.length}`)
  }

  interface Row {
    id: string
    address1: string
    city: string | null
    state: string | null
    zip: string | null
    lat: number
    lng: number
    status: string
    score: number
    opportunity_value: number | null
    last_outcome: string | null
    last_visit_at: number | null
    next_action_at: number | null
    next_action_label: string | null
    updated_at: number
    rep_name: string | null
  }
  const select = `SELECT p.id, p.address1, p.city, p.state, p.zip, p.lat, p.lng, p.status, p.score,
              p.opportunity_value, p.last_outcome, p.last_visit_at, p.next_action_at,
              p.next_action_label, p.updated_at, u.name AS rep_name
         FROM properties p
         LEFT JOIN users u ON u.id = p.assigned_rep_id
        WHERE ${where.join(' AND ')}`
  /*
    A chosen set of ids is read in chunks (D1's 100-parameter limit, see d1.ts)
    and sorted here the way the single query sorts; no ids means the filters
    alone decide, as before. An empty selection exports nothing — never
    "everything", which is what the old console did when its view was empty.
  */
  const leads: Row[] = pickIds
    ? (await inChunks<Row>(env, pickIds, (holes) => `${select} AND p.id IN (${holes})`, binds)).sort(
        (a, b) => a.address1.localeCompare(b.address1) || a.id.localeCompare(b.id),
      )
    : ((await env.DB.prepare(`${select} ORDER BY p.address1, p.id`).bind(...binds).all<Row>()).results ?? [])

  const ids = leads.map((l) => l.id)

  // The primary contact, or the first one there is.
  const contacts = await inChunks<{ property_id: string; name: string; phone: string | null; email: string | null; is_primary: number }>(
    env,
    ids,
    (holes) => `SELECT property_id, name, phone, email, is_primary FROM contacts WHERE property_id IN (${holes}) ORDER BY is_primary DESC, rowid`,
    [],
  )
  const contactOf = new Map<string, { name: string; phone: string | null; email: string | null }>()
  for (const c of contacts) if (!contactOf.has(c.property_id)) contactOf.set(c.property_id, c)

  // Live lists only. An archived list is put away, and a file should not keep
  // naming it beside every house it once held.
  const lists = await inChunks<{ property_id: string; name: string }>(
    env,
    ids,
    (holes) =>
      `SELECT m.property_id, l.name FROM lead_list_members m
         JOIN lead_lists l ON l.id = m.list_id
        WHERE l.client_id = ?1 AND l.archived = 0 AND m.property_id IN (${holes})
        ORDER BY l.name`,
    [actor.clientId],
  )
  const listsOf = new Map<string, string[]>()
  for (const l of lists) listsOf.set(l.property_id, [...(listsOf.get(l.property_id) ?? []), l.name])

  // Every note, oldest first, each signed and dated so the cell reads as a log.
  const notes = await inChunks<{ property_id: string; body: string; created_at: number; author: string | null }>(
    env,
    ids,
    (holes) =>
      `SELECT n.property_id, n.body, n.created_at, u.name AS author FROM notes n
         LEFT JOIN users u ON u.id = n.author_id
        WHERE n.property_id IN (${holes})
        ORDER BY n.created_at`,
    [],
  )
  const notesOf = new Map<string, string[]>()
  for (const n of notes) {
    if (!n.body) continue
    const line = `${iso(n.created_at).slice(0, 10)} ${n.author ?? 'someone'}: ${n.body}`
    notesOf.set(n.property_id, [...(notesOf.get(n.property_id) ?? []), line])
  }

  /*
    When the lead first showed up. The properties table carries no created_at
    — it predates the need — so the earliest thing that ever happened at the
    house stands in: the first visit, note, or logged activity. Blank for a
    lead that was imported and never touched, which is itself informative.
  */
  const firsts = await inChunks<{ property_id: string; first_at: number }>(
    env,
    ids,
    (holes) =>
      `SELECT property_id, MIN(at) AS first_at FROM (
         SELECT property_id, started_at AS at FROM visits WHERE property_id IN (${holes})
         UNION ALL
         SELECT property_id, created_at AS at FROM notes WHERE property_id IN (${holes})
         UNION ALL
         SELECT property_id, at FROM activity WHERE property_id IN (${holes})
       ) GROUP BY property_id`,
    [],
  )
  const firstOf = new Map(firsts.map((f) => [f.property_id, f.first_at]))

  const lines = [EXPORT_COLUMNS.join(',')]
  for (const l of leads) {
    const c = contactOf.get(l.id)
    lines.push(
      [
        csvField(l.id),
        csvField(l.address1, true),
        csvField(l.city, true),
        csvField(l.state, true),
        csvField(l.zip, true),
        csvField(l.lat),
        csvField(l.lng),
        csvField(l.status),
        csvField(c?.name ?? '', true),
        csvField(c?.phone ?? '', true),
        csvField(c?.email ?? '', true),
        csvField(l.rep_name ?? '', true),
        csvField((listsOf.get(l.id) ?? []).join('; '), true),
        csvField(l.score),
        csvField(l.opportunity_value ?? ''),
        csvField(l.last_outcome ?? '', true),
        csvField(iso(l.last_visit_at)),
        csvField(l.next_action_label ? `${iso(l.next_action_at).slice(0, 10)} ${l.next_action_label}`.trim() : '', true),
        csvField((notesOf.get(l.id) ?? []).join('\n'), true),
        csvField(iso(firstOf.get(l.id))),
        csvField(iso(l.updated_at)),
      ].join(','),
    )
  }
  // CRLF, as the RFC says and as Excel expects.
  const csv = lines.join('\r\n') + '\r\n'

  const day = new Date().toISOString().slice(0, 10)
  const label = typeof filter.label === 'string' && filter.label.trim() ? filter.label.trim().slice(0, 60) : null
  const slug = (label ?? listName ?? 'leads').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'leads'
  const filename = `allstar-${slug}-${day}.csv`

  await record(env, actor, {
    action: 'leads.exported',
    targetType: listId ? 'list' : undefined,
    targetId: listId ?? undefined,
    targetLabel: `${leads.length} lead${leads.length === 1 ? '' : 's'}${listName ? ` from ${listName}` : ''}`,
    detail: { rows: leads.length, listId, repId, status, territoryId, selected: pickIds?.length ?? null, label },
  })

  return { ok: true, csv, rows: leads.length, filename }
}
