import { geocode, useCensusBase } from './geocode'
import { territoryFor, parseBoundary, polygonAreaSqMiles, type TerritoryShape } from './geo'
import { planInboundFill, isNoop, type InboundContact, type LocalLead } from './crm-merge'
import { propertyIdFor } from './import'
import { linkIds, localIdFor } from './integrations'
import type { Env } from './types'

/**
 * Leads arriving from GoHighLevel.
 *
 * The other half of the sync. Push is ours calling them and can be retried at
 * leisure; this is them calling us, once, with no second chance if we drop it —
 * so the shape of this file is about never losing an inbound lead and never
 * trusting one.
 *
 * ## Who is calling, and for whom
 *
 * **The URL is the credential.** Each company gets
 * `/api/webhooks/ghl/<secret>`, and that secret is what identifies them. The
 * payload's `locationId` is *checked against* the one on file and never used to
 * decide whose data this is — an attacker controls every byte of a webhook body,
 * so resolving a tenant from it would let anyone write leads into any company's
 * account by guessing an id.
 *
 * A signature would be better. GoHighLevel's documentation is unreachable from
 * this build environment, so rather than invent a signing scheme and give it the
 * appearance of verification, this uses the pattern that is correct for a vendor
 * that does not sign: a long, unguessable, rotatable URL. If their signing is
 * confirmed later, it belongs here as an additional check rather than a
 * replacement.
 *
 * ## What it costs
 *
 * **Inbound leads are geocoded with the free Census geocoder and nothing else.**
 * Never a paid key, even when the company has one configured and a rooftop pin
 * would be better.
 *
 * The reason is the guardrail on the import screen: this app does not spend a
 * customer's money without showing them the estimate first and having somebody
 * agree to it. A webhook has nobody to ask. Wiring inbound leads to a paid
 * provider would mean a stranger's traffic — or a loop, or a bad month at
 * GoHighLevel — billing a customer for lookups nobody authorised, which is the
 * precise failure the estimate exists to prevent.
 *
 * The cost is real and is accepted: an inbound lead gets a block-level Census
 * pin rather than a Google rooftop. A lead Census cannot place arrives unplaced
 * and shows up in the console's unassigned count, where somebody can act on it.
 */

/** Deliberately narrow. Anything not named here is ignored rather than guessed at. */
export interface GhlWebhookBody {
  type?: string
  locationId?: string
  id?: string
  contactId?: string
  firstName?: string
  lastName?: string
  name?: string
  email?: string
  phone?: string
  address1?: string
  city?: string
  state?: string
  postalCode?: string
  country?: string
}

export type InboundOutcome =
  | { status: 'created'; propertyId: string; placed: boolean }
  | { status: 'filled'; propertyId: string; filled: string[] }
  | { status: 'ignored'; reason: string }

/**
 * A company's webhook secret, created on first request.
 *
 * Stored rather than derived so it can be rotated without touching anything
 * else. It is returned to admins — who can already read and write this
 * integration — because an admin has to paste it into GoHighLevel, and a secret
 * shown once and then lost means a support conversation instead of a settings
 * page.
 */
export async function webhookSecret(
  env: Env,
  clientId: string,
  { rotate = false } = {},
): Promise<string | null> {
  const row = await env.DB.prepare(
    `SELECT config FROM client_integrations WHERE client_id = ?1 AND provider = 'ghl'`,
  )
    .bind(clientId)
    .first<{ config: string }>()
  if (!row) return null

  let cfg: Record<string, unknown> = {}
  try {
    cfg = JSON.parse(row.config ?? '{}') as Record<string, unknown>
  } catch {
    cfg = {}
  }

  const existing = typeof cfg.webhookSecret === 'string' ? cfg.webhookSecret : ''
  if (existing && !rotate) return existing

  // 32 bytes of randomness, hex. Long enough that guessing is not a strategy,
  // and URL-safe without encoding so it survives being pasted by hand.
  const bytes = crypto.getRandomValues(new Uint8Array(32))
  const secret = [...bytes].map((b) => b.toString(16).padStart(2, '0')).join('')
  cfg.webhookSecret = secret

  await env.DB.prepare(
    `UPDATE client_integrations SET config = ?2 WHERE client_id = ?1 AND provider = 'ghl'`,
  )
    .bind(clientId, JSON.stringify(cfg))
    .run()
  return secret
}

/**
 * Whose webhook is this?
 *
 * Scans connected integrations for a matching secret. There is no index on a
 * JSON field, which is fine at this scale and is the reason the comparison is
 * written out rather than pushed into SQL — a `LIKE` over a config blob would
 * match a secret appearing anywhere in it, including inside a different key.
 */
export async function clientForSecret(env: Env, secret: string): Promise<string | null> {
  if (!secret || secret.length < 32) return null
  const rows = await env.DB.prepare(
    `SELECT client_id, config FROM client_integrations WHERE provider = 'ghl' AND status != 'disconnected'`,
  ).all<{ client_id: string; config: string }>()

  for (const row of rows.results ?? []) {
    try {
      const cfg = JSON.parse(row.config ?? '{}') as { webhookSecret?: string }
      if (cfg.webhookSecret && cfg.webhookSecret === secret) return row.client_id
    } catch {
      continue
    }
  }
  return null
}

const text = (v: unknown): string => (typeof v === 'string' ? v.trim() : '')

/** Their name fields are inconsistent; accept whichever arrived. */
function personName(body: GhlWebhookBody): string {
  const joined = [text(body.firstName), text(body.lastName)].filter(Boolean).join(' ')
  return text(body.name) || joined
}

/**
 * Apply one webhook.
 *
 * Everything it can refuse, it refuses with a reason rather than an error: a
 * webhook that 500s gets retried by the sender, and retrying a payload we have
 * decided not to act on is load without benefit for both sides.
 */
export async function applyInbound(
  env: Env,
  clientId: string,
  body: GhlWebhookBody,
): Promise<InboundOutcome> {
  /*
    The location check. Not how the tenant is chosen — the URL secret did that —
    but a mismatch means the secret and the sub-account have drifted apart, and
    writing a stranger's leads into this company's database is worse than
    dropping one.
  */
  const configured = await env.DB.prepare(
    `SELECT location_id FROM client_integrations WHERE client_id = ?1 AND provider = 'ghl'`,
  )
    .bind(clientId)
    .first<{ location_id: string | null }>()
  const claimed = text(body.locationId)
  if (claimed && configured?.location_id && claimed !== configured.location_id) {
    return { status: 'ignored', reason: 'that payload is for a different GoHighLevel sub-account' }
  }

  const remoteId = text(body.id) || text(body.contactId)
  if (!remoteId) return { status: 'ignored', reason: 'no contact id on the payload' }

  const incoming: InboundContact = {
    firstName: body.firstName,
    lastName: body.lastName,
    name: body.name,
    email: body.email,
    phone: body.phone,
    city: body.city,
    state: body.state,
    postalCode: body.postalCode,
  }

  /* --- already ours? then the fill rule decides, and it fills blanks only --- */

  const known = await localIdFor(env, clientId, 'contact', remoteId)
  if (known) {
    const property = await env.DB.prepare(
      `SELECT id, city, state, zip FROM properties WHERE id = ?1 AND client_id = ?2`,
    )
      .bind(known, clientId)
      .first<{ id: string; city: string | null; state: string | null; zip: string | null }>()
    if (!property) return { status: 'ignored', reason: 'that lead no longer exists here' }

    const contact = await env.DB.prepare(
      `SELECT id, name, phone, email FROM contacts WHERE property_id = ?1
        ORDER BY is_primary DESC, id LIMIT 1`,
    )
      .bind(known)
      .first<{ id: string; name: string; phone: string | null; email: string | null }>()

    const local: LocalLead = {
      propertyId: property.id,
      city: property.city,
      state: property.state,
      zip: property.zip,
      contact: contact ?? null,
    }
    const plan = planInboundFill(local, incoming)
    if (isNoop(plan)) {
      return { status: 'ignored', reason: 'nothing to fill — Allstar already has a value for each' }
    }

    if (Object.keys(plan.property).length) {
      const sets: string[] = []
      const binds: unknown[] = [property.id, clientId]
      for (const [field, value] of Object.entries(plan.property)) {
        // Field names come from the plan's own closed key set, never from the
        // payload, so this cannot become an injection point.
        binds.push(value)
        sets.push(`${field} = ?${binds.length}`)
      }
      await env.DB.prepare(
        `UPDATE properties SET ${sets.join(', ')}, updated_at = ${Date.now()}
          WHERE id = ?1 AND client_id = ?2`,
      )
        .bind(...binds)
        .run()
    }

    if (plan.contact.action === 'update') {
      await env.DB.prepare(
        `UPDATE contacts SET phone = COALESCE(?2, phone), email = COALESCE(?3, email) WHERE id = ?1`,
      )
        .bind(plan.contact.id, plan.contact.phone ?? null, plan.contact.email ?? null)
        .run()
    } else if (plan.contact.action === 'create') {
      await env.DB.prepare(
        `INSERT INTO contacts (id, property_id, name, phone, email, is_primary)
         VALUES (?1,?2,?3,?4,?5,1)`,
      )
        .bind(
          `c_${crypto.randomUUID().replace(/-/g, '').slice(0, 20)}`,
          property.id,
          plan.contact.name,
          plan.contact.phone ?? null,
          plan.contact.email ?? null,
        )
        .run()
    }

    return { status: 'filled', propertyId: property.id, filled: plan.filled }
  }

  /* --- new to us --------------------------------------------------------- */

  const address1 = text(body.address1)
  if (!address1) {
    // A contact with no address is not a lead this app can do anything with:
    // there is no door to knock on, no territory to fall in, no pin to draw.
    return { status: 'ignored', reason: 'no street address, so there is no door to knock on' }
  }

  const row = {
    address1,
    city: text(body.city),
    state: text(body.state),
    zip: text(body.postalCode),
  }

  /*
    The same id an import would give this address. Deterministic and
    tenant-scoped, so a lead that arrives from GoHighLevel and the same address
    in a CSV are one row rather than two — the dedupe is free and does not depend
    on anybody remembering to check.
  */
  const propertyId = await propertyIdFor(clientId, { ref: 'inbound', ...row })

  const existing = await env.DB.prepare(
    `SELECT id FROM properties WHERE id = ?1 AND client_id = ?2`,
  )
    .bind(propertyId, clientId)
    .first<{ id: string }>()

  /*
    Census only, never a paid key — see the note at the top of this file. A
    webhook has nobody to show a spend estimate to.
  */
  let lat = 0
  let lng = 0
  let placed = false
  try {
    useCensusBase(env.CENSUS_BASE_URL)
    const [match] = await geocode([{ ref: 'inbound', ...row }], {})
    if (match?.status === 'match' && typeof match.lat === 'number' && typeof match.lng === 'number') {
      lat = match.lat
      lng = match.lng
      placed = true
    }
  } catch {
    // An unplaced lead is a lead somebody can still work. A geocoder having a
    // bad minute must not cost us the lead itself.
    placed = false
  }

  let territoryId: string | null = null
  if (placed) {
    // Built exactly as the CSV import builds them, so a lead landing here and the
    // same lead landing through a file fall in the same territory.
    const drawn = await env.DB.prepare(
      `SELECT id, rep_id, boundary FROM territories WHERE client_id = ?1 AND boundary IS NOT NULL`,
    )
      .bind(clientId)
      .all<{ id: string; rep_id: string | null; boundary: string }>()
    const shapes: TerritoryShape[] = []
    for (const t of drawn.results ?? []) {
      const boundary = parseBoundary(t.boundary)
      if (!boundary) continue
      shapes.push({
        id: String(t.id),
        repId: t.rep_id == null ? null : String(t.rep_id),
        boundary,
        areaSqMiles: polygonAreaSqMiles(boundary),
      })
    }
    territoryId = shapes.length ? (territoryFor({ lat, lng }, shapes)?.id ?? null) : null
  }

  await env.DB.prepare(
    `INSERT OR IGNORE INTO properties
       (id, client_id, address1, city, state, zip, lat, lng, status, score, territory_id, updated_at)
     VALUES (?1,?2,?3,?4,?5,?6,?7,?8,'new',50,?9,?10)`,
  )
    .bind(
      propertyId,
      clientId,
      row.address1,
      row.city || null,
      row.state || null,
      row.zip || null,
      lat,
      lng,
      territoryId,
      Date.now(),
    )
    .run()

  const name = personName(body)
  const phone = text(body.phone)
  const email = text(body.email)
  if (name || phone || email) {
    await env.DB.prepare(
      `INSERT INTO contacts (id, property_id, name, phone, email, is_primary)
       VALUES (?1,?2,?3,?4,?5,1)`,
    )
      .bind(
        `c_${crypto.randomUUID().replace(/-/g, '').slice(0, 20)}`,
        propertyId,
        name || 'Unknown',
        phone || null,
        email || null,
      )
      .run()
  }

  // Linked whether or not the row was newly inserted: if the address already
  // existed, this is still the GoHighLevel contact that corresponds to it, and
  // without the link the next webhook would take the create path again.
  await linkIds(env, clientId, 'contact', propertyId, remoteId)

  return { status: existing ? 'filled' : 'created', propertyId, placed, filled: [] } as InboundOutcome
}

