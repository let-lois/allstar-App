import { record } from './audit'
import { bindChunks } from './d1'
import type { Env, SessionUser } from './types'

/**
 * Erasing a lead, and everything that hangs off it.
 *
 * Until this existed the product could not delete a homeowner's data at all —
 * not slowly, not by hand. Every `DELETE FROM` in the API was configuration,
 * bookkeeping, or a staff account. Addresses, contact details, the free-text
 * notes a rep typed about a household, and the photographs of their house had
 * no way out. `LEGAL.md` question 3 asks counsel how long those may be kept;
 * this is the machinery that makes any answer executable.
 *
 * ## Four places, and only the first is easy
 *
 * **D1.** Deleting the property is enough: every child table declares
 * `ON DELETE CASCADE` on `property_id`, and D1 enforces it — tested rather than
 * assumed, because if it did not, this would delete the property and leave
 * orphaned contacts, notes and photo rows. Data that *looks* erased and is not
 * is worse than data that was never erased, since nobody goes looking again.
 *
 * **R2.** The photo files are a separate store and go separately. Their keys are
 * read and written into the tombstone *before* anything is deleted, so a failure
 * half way through leaves a record of what was meant rather than orphaned
 * objects nobody can find.
 *
 * **Every rep's phone.** Not handled here, but handled: each device holds a full
 * offline copy by design and deleting server-side does not touch it, so the
 * erased ids ride out on `/api/bootstrap` and the device purges its own copies.
 * That matters most for visits, notes and photographs, which bootstrap never
 * returns — nothing in an ordinary refresh could ever have removed one. See
 * `src/lib/erase-local.ts`, and `applyMutations`, which discards queued work
 * aimed at an erased lead rather than letting a phone put it back.
 *
 * **Backups.** Every encrypted dump still contains the erased lead, and nobody
 * rewrites backups. Whether "erased going forward" satisfies a request is a
 * question for counsel, not an engineering decision to make quietly.
 *
 * ## It has to stay erased
 *
 * `properties.id` is derived from the client and the normalised address, so the
 * same address always resolves to the same id. The `deletions` row therefore
 * blocks every route back in — a CSV carrying that address again, a GoHighLevel
 * webhook for the same contact, a rep adding it at the door. An erasure that
 * Tuesday's import quietly undoes is not an erasure.
 */

/**
 * Who may erase.
 *
 * Deliberately narrower than who may import. A manager runs the day and can
 * already reassign, re-route and close a lead; none of that destroys anything.
 * Erasure is the one action with no undo, and it exists to serve a legal
 * obligation the account owner carries — so it sits with the owner and with us,
 * not with whoever is running this week's crew.
 */
export function canErase(user: SessionUser): boolean {
  return user.role === 'client_admin' || user.role === 'super_admin'
}

export interface EraseResult {
  ok: true
  propertyId: string
  photos: number
  /** True when the row was already gone and only the tombstone was written. */
  alreadyGone: boolean
}

export type EraseFailure = { ok: false; error: string; status: number }

/**
 * A reason is required, and not as ceremony. The one question asked afterwards
 * is always "why is this gone" — by an auditor, by the customer, or by whoever
 * is trying to work out whether it was a mistake. A blank field there makes
 * every erasure indistinguishable from an accident.
 */
const MIN_REASON = 3
const NO_REASON = 'Say why this is being erased — it cannot be undone.'

export async function eraseProperty(
  env: Env,
  actor: SessionUser,
  propertyId: string,
  reason: string,
): Promise<EraseResult | EraseFailure> {
  if (!canErase(actor)) return { ok: false, error: 'Not permitted.', status: 403 }
  if (!propertyId) return { ok: false, error: 'Which lead?', status: 400 }
  const why = reason.trim()
  if (why.length < MIN_REASON) return { ok: false, error: NO_REASON, status: 400 }
  return eraseOne(env, actor, propertyId, why)
}

/**
 * Many leads, one decision.
 *
 * The console's bulk bar selects by checkbox and by drawing round pins on the
 * map, and an office that has just had a scrubbed list back, or a street of
 * households ask to be forgotten, should not have to erase them one at a time
 * — or worse, be tempted to leave them because it is tedious.
 *
 * Every rule of the single erase holds per lead, because it *is* the single
 * erase, called in a loop: admin only, a reason, tenant-scoped, tombstone
 * first, cascade, files, audit line each. What this adds is the shape of the
 * request and the honesty of the answer.
 *
 * There is no transaction across the batch, and none is pretended. D1 cannot
 * span R2, and a tombstone written before its row is destroyed is already the
 * unit that must not tear. So a lead that fails half way is reported as
 * failed, by id, and the rest proceed — "8 deleted, 2 could not be" is a true
 * sentence the console can show; "done" over a batch that was not is the bug
 * this exists to avoid.
 *
 * Ids are deduplicated (the same row ticked in the list and lassoed on the map
 * arrives twice), capped at the same ceiling as reassignment, and every one is
 * checked against the caller's company inside `eraseOne` — an id from another
 * tenant is "not found", the same answer as one that never existed.
 */
export interface BulkEraseResult {
  ok: true
  /** Distinct ids after deduplication. */
  requested: number
  /** Rows destroyed, with tombstones written. */
  deleted: number
  /** Already erased before this call; tombstone confirmed, nothing to destroy. */
  alreadyGone: number
  /** Not this company's, or never existed. Nothing written for these. */
  notFound: string[]
  /** Something went wrong part way for these. Their tombstones may exist. */
  failed: string[]
  /** Files removed from object storage across the batch. */
  photos: number
}

export const BULK_ERASE_MAX = 500

export async function eraseProperties(
  env: Env,
  actor: SessionUser,
  propertyIds: unknown,
  reason: unknown,
): Promise<BulkEraseResult | EraseFailure> {
  if (!canErase(actor)) return { ok: false, error: 'Not permitted.', status: 403 }
  if (!Array.isArray(propertyIds)) return { ok: false, error: 'Send the leads as a list of ids.', status: 400 }
  const ids = [...new Set(propertyIds.filter((x): x is string => typeof x === 'string' && x.trim() !== '').map((x) => x.trim()))]
  if (ids.length === 0) return { ok: false, error: 'No leads selected.', status: 400 }
  if (ids.length > BULK_ERASE_MAX) return { ok: false, error: `Select at most ${BULK_ERASE_MAX} leads.`, status: 413 }
  const why = typeof reason === 'string' ? reason.trim() : ''
  if (why.length < MIN_REASON) return { ok: false, error: NO_REASON, status: 400 }

  const out: BulkEraseResult = { ok: true, requested: ids.length, deleted: 0, alreadyGone: 0, notFound: [], failed: [], photos: 0 }
  for (const id of ids) {
    try {
      const r = await eraseOne(env, actor, id, why)
      if (!r.ok) {
        // The only failure eraseOne returns for a checked actor and reason is
        // "not yours / not there" — nothing was written, so it is safe to say so.
        out.notFound.push(id)
        continue
      }
      if (r.alreadyGone) out.alreadyGone += 1
      else out.deleted += 1
      out.photos += r.photos
    } catch (err) {
      console.error('erase-bulk: lead failed part way', id, String(err))
      out.failed.push(id)
    }
  }

  // One line for the act as a whole, beside the one per lead. An auditor
  // reading "lead.erased" forty times wants to know it was one decision.
  await record(env, actor, {
    action: 'leads.bulk_erased',
    targetType: 'lead',
    targetId: `${ids.length}`,
    targetLabel: `${out.deleted} erased`,
    detail: { reason: why, requested: out.requested, deleted: out.deleted, alreadyGone: out.alreadyGone, notFound: out.notFound.length, failed: out.failed.length },
  })
  return out
}

/** One lead, for a caller that has already checked who is asking and why. */
async function eraseOne(
  env: Env,
  actor: SessionUser,
  propertyId: string,
  why: string,
): Promise<EraseResult | EraseFailure> {
  // Tenant-scoped, like every id crossing this boundary. Erasing another
  // company's lead would be the worst possible version of this bug.
  const property = await env.DB.prepare(
    `SELECT id, address1 FROM properties WHERE id = ?1 AND client_id = ?2`,
  )
    .bind(propertyId, actor.clientId)
    .first<{ id: string; address1: string }>()

  /*
    Read the file keys before deleting anything. After the row is gone there is
    no way to find the objects, and R2 does not know what a property is.
  */
  const photoRows = property
    ? await env.DB.prepare(
        `SELECT r2_key FROM photos WHERE property_id = ?1 AND client_id = ?2 AND r2_key IS NOT NULL`,
      )
        .bind(propertyId, actor.clientId)
        .all<{ r2_key: string }>()
    : { results: [] as { r2_key: string }[] }
  const keys = (photoRows.results ?? []).map((r) => r.r2_key).filter(Boolean)

  /*
    An id that is neither ours nor already erased is refused.

    Without this, `eraseProperty` wrote a tombstone for any id at all — so an
    admin could fill their own block-list with ids that were never theirs, and
    every such call left an audit entry saying a lead had been erased when
    nothing had. Found because the gate counted two audit rows where it expected
    one.

    404 rather than 403, and the same wording whether the id belongs to another
    company or to nobody: "not yours" is all an answer here should reveal. It
    does not leak whether another tenant holds that id, which is the same
    reasoning the user endpoints use.
  */
  const tombstoned = await env.DB.prepare(
    `SELECT 1 AS yes FROM deletions
      WHERE client_id = ?1 AND entity = 'property' AND entity_id = ?2`,
  )
    .bind(actor.clientId, propertyId)
    .first<{ yes: number }>()
  if (!property && !tombstoned) {
    return { ok: false, error: 'No such lead on this team.', status: 404 }
  }

  /*
    The tombstone goes in first, before a single byte is destroyed.

    If the delete fails half way — R2 unavailable, the Worker killed — what is
    left is a record saying this lead was meant to be erased, which somebody can
    act on. The other order leaves destroyed data and no record of intent, and
    the block on re-import would not exist either, so the next CSV would bring
    the lead back.

    `OR REPLACE` because erasing something already erased is not an error: the
    honest response to "erase this" when it is already gone is to confirm it.
  */
  await env.DB.prepare(
    `INSERT OR REPLACE INTO deletions
       (client_id, entity, entity_id, actor_id, actor_name, reason, photos, at)
     VALUES (?1,'property',?2,?3,?4,?5,?6,?7)`,
  )
    .bind(actor.clientId, propertyId, actor.id, actor.name, why.slice(0, 500), keys.length, Date.now())
    .run()

  if (!property) {
    // Nothing to destroy, but the block is now in place — which is the part that
    // matters for an address that could otherwise be re-imported.
    await record(env, actor, {
      action: 'lead.erased',
      targetType: 'lead',
      targetId: propertyId,
      targetLabel: 'already erased',
      detail: { reason: why, photos: 0, alreadyGone: true },
    })
    return { ok: true, propertyId, photos: 0, alreadyGone: true }
  }

  /*
    Files before rows. If R2 refuses, the photo rows still point at objects that
    exist and the erasure can be retried; the reverse leaves rows pointing at
    nothing, which the app renders as broken images and nobody can clean up.

    One failure does not stop the rest: a key that will not delete is worth
    knowing about, but it must not leave the addresses and phone numbers in
    place.
  */
  let filesLeft = 0
  if (env.PHOTOS) {
    for (const key of keys) {
      try {
        await env.PHOTOS.delete(key)
      } catch (err) {
        filesLeft += 1
        console.error('erase: R2 delete failed', key, String(err))
      }
    }
  }

  /*
    The link to GoHighLevel goes too. Left behind, an inbound webhook for that
    contact would find the link, look for a property that no longer exists, and
    quietly do nothing forever — so the lead could never be re-created even
    deliberately, and the failure would be invisible.
  */
  await env.DB.prepare(
    `DELETE FROM integration_links WHERE client_id = ?1 AND kind = 'contact' AND local_id = ?2`,
  )
    .bind(actor.clientId, propertyId)
    .run()

  /*
    One statement, and the cascade does the rest: contacts, visits, notes,
    photos, appointments, tasks, activity and route stops all declare
    `ON DELETE CASCADE` on `property_id`. That D1 honours it was verified against
    a real local database rather than taken from the schema — the schema declaring
    a cascade and the engine performing one are different claims.
  */
  await env.DB.prepare(`DELETE FROM properties WHERE id = ?1 AND client_id = ?2`)
    .bind(propertyId, actor.clientId)
    .run()

  await record(env, actor, {
    action: 'lead.erased',
    targetType: 'lead',
    targetId: propertyId,
    // The address as it read at the time. This is the audit log, whose job is to
    // say what was done; an erasure nobody can identify afterwards cannot be
    // checked, and it is the one record deliberately kept.
    targetLabel: property.address1,
    detail: { reason: why, photos: keys.length, filesLeft: filesLeft || undefined },
  })

  return { ok: true, propertyId, photos: keys.length, alreadyGone: false }
}

/**
 * Which of these ids have been erased, so nothing brings them back.
 *
 * Takes a batch because the caller that matters most is a CSV import with a
 * thousand rows in it, and asking once per row would be a thousand round trips
 * to answer a question one query covers.
 */
export async function erasedAmong(
  env: Env,
  clientId: string,
  propertyIds: string[],
): Promise<Set<string>> {
  const out = new Set<string>()
  if (propertyIds.length === 0) return out

  /*
    Chunked because D1 binds at most 100 parameters per statement (see d1.ts)
    and an import is not bounded by anything except what somebody dragged onto
    the page. This was 200 — "well inside the limit" for SQLite, double D1's —
    and it is what failed every import and territory of 100 or more houses.
  */
  for (const slice of bindChunks(propertyIds, 1)) {
    const holes = slice.map((_, n) => `?${n + 2}`).join(',')
    const rows = await env.DB.prepare(
      `SELECT entity_id FROM deletions
        WHERE client_id = ?1 AND entity = 'property' AND entity_id IN (${holes})`,
    )
      .bind(clientId, ...slice)
      .all<{ entity_id: string }>()
    for (const r of rows.results ?? []) out.add(r.entity_id)
  }
  return out
}

/** One id, for the inbound webhook path where rows arrive singly. */
export async function isErased(env: Env, clientId: string, propertyId: string): Promise<boolean> {
  const row = await env.DB.prepare(
    `SELECT 1 AS yes FROM deletions
      WHERE client_id = ?1 AND entity = 'property' AND entity_id = ?2`,
  )
    .bind(clientId, propertyId)
    .first<{ yes: number }>()
  return !!row
}

/**
 * Let an address be imported again.
 *
 * The tombstone exists so that an erasure is never undone *silently* — the next
 * CSV upload must not quietly recreate a lead somebody deliberately destroyed.
 * That is a property worth keeping, and this does not weaken it: it is the
 * loudest possible way to lift one, admin-only, with a reason, and an audit
 * line naming every address.
 *
 * Without it the block was permanent with no affordance anywhere in the
 * product. Nothing in the API removed a row from `deletions`, so an address
 * erased while clearing out test data could never be imported again for that
 * company — not by a CSV, not by a webhook, not by a rep standing in front of
 * the house. The only remedy was hand-editing the database.
 *
 * What it does NOT do is bring anything back. The lead, its notes, its visits
 * and its photos are gone and stay gone; all this says is that the address is
 * allowed to exist again. An erasure made because a homeowner asked to be
 * removed should never be lifted, which is why the reason is mandatory and the
 * console says so beside the button.
 */
export async function unblockProperties(
  env: Env,
  actor: SessionUser,
  propertyIds: unknown,
  reason: unknown,
): Promise<{ ok: true; unblocked: number; requested: number } | EraseFailure> {
  if (!canErase(actor)) return { ok: false, error: 'Not permitted.', status: 403 }
  if (!Array.isArray(propertyIds)) return { ok: false, error: 'Send the addresses as a list of ids.', status: 400 }
  const ids = [...new Set(propertyIds.filter((x): x is string => typeof x === 'string' && x.trim() !== '').map((x) => x.trim()))]
  if (ids.length === 0) return { ok: false, error: 'No addresses selected.', status: 400 }
  if (ids.length > BULK_ERASE_MAX) return { ok: false, error: `Select at most ${BULK_ERASE_MAX} addresses.`, status: 413 }
  const why = typeof reason === 'string' ? reason.trim() : ''
  if (why.length < MIN_REASON) {
    return { ok: false, error: 'Say why this address should be allowed back — lifting a block is recorded.', status: 400 }
  }

  let unblocked = 0
  // Chunked for the same reason `erasedAmong` is: an import is not bounded by
  // anything except what somebody dragged onto the page.
  for (const slice of bindChunks(ids, 1)) {
    const marks = slice.map((_, n) => `?${n + 2}`).join(',')
    const res = await env.DB.prepare(
      `DELETE FROM deletions
        WHERE client_id = ?1 AND entity = 'property' AND entity_id IN (${marks})`,
    )
      .bind(actor.clientId, ...slice)
      .run()
    unblocked += Number(res.meta?.changes ?? 0)
  }

  await record(env, actor, {
    action: 'leads.unblocked',
    targetType: 'lead',
    targetId: `${ids.length}`,
    targetLabel: `${unblocked} allowed back`,
    detail: { reason: why, requested: ids.length, unblocked },
  })
  return { ok: true, unblocked, requested: ids.length }
}
