import { canImport } from './import'
import { dayKeyIn, dayRangeIn } from './day'
import type { Env, SessionUser } from './types'

/**
 * Plans and deals: what was sold, for how much, by whom, and when.
 *
 * Before this, every dollar figure in the app was the imported
 * `opportunity_value` column, and nothing in the app could set it. Now:
 *
 *   - the office keeps a price list (`plans`);
 *   - a lead becoming Won — a Sold visit, a hand-set status, the office's bulk
 *     change — opens its sale (`deals`), stamped with the rep and the moment;
 *   - the sale's value is the chosen plan's price, or, before a plan is
 *     chosen, the lead's imported estimate, so nothing reads $0 that used to
 *     read something;
 *   - a manager may override the value, and who did it and why is kept;
 *   - a lead leaving Won cancels its sale, so "Won" and "has a sale" are
 *     always the same set of leads.
 *
 * One row per lead (`deal_<property id>`): a lead re-won after a cancellation
 * reuses its row instead of counting twice, and two Sold visits on one house
 * are one sale.
 */

export const dealIdFor = (propertyId: string) => `deal_${propertyId}`

/** Whole dollars, like `opportunity_value`. Ten million is a typo, not a sale. */
const MAX_VALUE = 10_000_000

interface DealRow {
  id: string
  rep_id: string | null
  plan_id: string | null
  value: number
  status: string
  won_at: number
}

interface PlanRow {
  id: string
  name: string
  value: number
  active: number
}

async function dealOf(env: Env, clientId: string, propertyId: string): Promise<DealRow | null> {
  return env.DB.prepare(
    'SELECT id, rep_id, plan_id, value, status, won_at FROM deals WHERE id = ?1 AND client_id = ?2',
  )
    .bind(dealIdFor(propertyId), clientId)
    .first<DealRow>()
}

async function planOf(env: Env, clientId: string, planId: string | null | undefined): Promise<PlanRow | null> {
  if (!planId) return null
  return env.DB.prepare('SELECT id, name, value, active FROM plans WHERE id = ?1 AND client_id = ?2')
    .bind(planId, clientId)
    .first<PlanRow>()
}

/**
 * Open (or reopen) the sale on a lead that has just become Won.
 *
 * A lead already sold keeps its sale, its rep and its moment — a second Sold
 * visit is not a second sale — but a plan chosen now is applied to it, because
 * "which plan" is often settled after the door.
 */
export async function winDeal(
  env: Env,
  user: SessionUser,
  opts: { propertyId: string; repId: string | null; wonAt: number; planId?: string | null; visitId?: string | null },
): Promise<void> {
  const existing = await dealOf(env, user.clientId, opts.propertyId)
  // Only an active plan may be chosen; a retired one stays on old sales only.
  const plan = await planOf(env, user.clientId, opts.planId)
  const chosen = plan && plan.active ? plan : null
  const now = Date.now()

  if (existing?.status === 'won') {
    if (!chosen || chosen.id === existing.plan_id) return
    await env.DB.prepare(
      `UPDATE deals SET plan_id = ?2, plan_name = ?3, plan_value = ?4, value = ?4,
              value_overridden_by = NULL, override_reason = NULL, updated_at = ?5
        WHERE id = ?1`,
    )
      .bind(existing.id, chosen.id, chosen.name, chosen.value, now)
      .run()
    await recomputeDailyStats(env, user.clientId, existing.rep_id, user.timezone, existing.won_at)
    return
  }

  let value = chosen?.value
  if (value == null) {
    const p = await env.DB.prepare('SELECT opportunity_value AS v FROM properties WHERE id = ?1 AND client_id = ?2')
      .bind(opts.propertyId, user.clientId)
      .first<{ v: number | null }>()
    value = p?.v ?? 0
  }
  await env.DB.prepare(
    `INSERT INTO deals
       (id, client_id, property_id, rep_id, plan_id, plan_name, plan_value, value,
        status, won_at, visit_id, created_at, updated_at)
     VALUES (?1,?2,?3,?4,?5,?6,?7,?8,'won',?9,?10,?11,?11)
     ON CONFLICT(id) DO UPDATE SET
       rep_id = excluded.rep_id,
       plan_id = excluded.plan_id,
       plan_name = excluded.plan_name,
       plan_value = excluded.plan_value,
       value = excluded.value,
       value_overridden_by = NULL,
       override_reason = NULL,
       status = 'won',
       won_at = excluded.won_at,
       visit_id = excluded.visit_id,
       updated_at = excluded.updated_at`,
  )
    .bind(
      dealIdFor(opts.propertyId),
      user.clientId,
      opts.propertyId,
      opts.repId,
      chosen?.id ?? null,
      chosen?.name ?? null,
      chosen?.value ?? null,
      value,
      opts.wonAt,
      opts.visitId ?? null,
      now,
    )
    .run()
  await recomputeDailyStats(env, user.clientId, opts.repId, user.timezone, opts.wonAt)
}

/** A lead that has left Won: its sale no longer counts, on the day it was won. */
export async function cancelDeal(env: Env, user: SessionUser, propertyId: string): Promise<void> {
  const existing = await dealOf(env, user.clientId, propertyId)
  if (existing?.status !== 'won') return
  await env.DB.prepare("UPDATE deals SET status = 'cancelled', updated_at = ?2 WHERE id = ?1")
    .bind(existing.id, Date.now())
    .run()
  await recomputeDailyStats(env, user.clientId, existing.rep_id, user.timezone, existing.won_at)
}

/** Bring a lead's sale in line with the status it now has. */
export async function syncDealToStatus(
  env: Env,
  user: SessionUser,
  propertyId: string,
  status: string,
  opts: { repId: string | null; wonAt: number },
): Promise<void> {
  if (status === 'won') await winDeal(env, user, { propertyId, ...opts })
  else await cancelDeal(env, user, propertyId)
}

/**
 * A change to a sale after the fact: a different plan (anyone who may edit the
 * lead), or a different value (a manager, with a reason).
 *
 * Returns the activity line to record; throws, in words, when refused.
 */
export async function updateDeal(
  env: Env,
  user: SessionUser,
  input: { propertyId: string; planId?: unknown; value?: unknown; reason?: unknown },
): Promise<string> {
  const existing = await dealOf(env, user.clientId, input.propertyId)
  if (existing?.status !== 'won') throw new Error('This lead has no sale to change. Mark it Won first.')
  const now = Date.now()
  let summary: string

  if (input.value !== undefined && input.value !== null) {
    if (!canImport(user)) throw new Error('Only a manager can change what a sale is worth.')
    const value = typeof input.value === 'number' ? Math.round(input.value) : NaN
    if (!Number.isFinite(value) || value < 0 || value > MAX_VALUE) throw new Error('Enter a value between $0 and $10,000,000.')
    const reason = typeof input.reason === 'string' ? input.reason.trim().slice(0, 200) : ''
    if (!reason) throw new Error('Say why the value is being changed.')
    await env.DB.prepare(
      'UPDATE deals SET value = ?2, value_overridden_by = ?3, override_reason = ?4, updated_at = ?5 WHERE id = ?1',
    )
      .bind(existing.id, value, user.id, reason, now)
      .run()
    summary = `Sale value set to ${dollars(value)} (was ${dollars(existing.value)}): ${reason}`
  } else if (typeof input.planId === 'string' && input.planId) {
    const plan = await planOf(env, user.clientId, input.planId)
    if (!plan || !plan.active) throw new Error('That plan is not on the price list.')
    if (plan.id === existing.plan_id) return ''
    await env.DB.prepare(
      `UPDATE deals SET plan_id = ?2, plan_name = ?3, plan_value = ?4, value = ?4,
              value_overridden_by = NULL, override_reason = NULL, updated_at = ?5
        WHERE id = ?1`,
    )
      .bind(existing.id, plan.id, plan.name, plan.value, now)
      .run()
    summary = `Sale plan set to ${plan.name} (${dollars(plan.value)})`
  } else {
    throw new Error('Nothing to change on this sale.')
  }

  await recomputeDailyStats(env, user.clientId, existing.rep_id, user.timezone, existing.won_at)
  return summary
}

const dollars = (n: number) => `$${Math.round(n).toLocaleString('en-US')}`

/* --- the price list ------------------------------------------------------- */

export interface PlanDTO {
  id: string
  name: string
  value: number
  active: boolean
  sort: number
}

const toPlan = (r: Record<string, unknown>): PlanDTO => ({
  id: String(r.id),
  name: String(r.name),
  value: Number(r.value ?? 0),
  active: Number(r.active ?? 1) === 1,
  sort: Number(r.sort ?? 0),
})

export async function listPlans(env: Env, clientId: string): Promise<PlanDTO[]> {
  const res = await env.DB.prepare('SELECT * FROM plans WHERE client_id = ?1 ORDER BY sort, name')
    .bind(clientId)
    .all()
  return (res.results as Record<string, unknown>[]).map(toPlan)
}

type Failure = { error: string; status: number }

function cleanPlan(body: Record<string, unknown>, partial: boolean): { name?: string; value?: number; active?: boolean; sort?: number } | Failure {
  const out: { name?: string; value?: number; active?: boolean; sort?: number } = {}
  if (body.name !== undefined || !partial) {
    const name = typeof body.name === 'string' ? body.name.trim().slice(0, 80) : ''
    if (!name) return { error: 'Give the plan a name.', status: 400 }
    out.name = name
  }
  if (body.value !== undefined || !partial) {
    const value = typeof body.value === 'number' ? Math.round(body.value) : NaN
    if (!Number.isFinite(value) || value < 0 || value > MAX_VALUE) return { error: 'Enter a price between $0 and $10,000,000.', status: 400 }
    out.value = value
  }
  if (typeof body.active === 'boolean') out.active = body.active
  if (typeof body.sort === 'number' && Number.isFinite(body.sort)) out.sort = Math.round(body.sort)
  return out
}

/** The office's price list. Managers and administrators; never a rep. */
export async function createPlan(env: Env, user: SessionUser, body: Record<string, unknown>): Promise<PlanDTO | Failure> {
  if (!canImport(user)) return { error: 'Not permitted.', status: 403 }
  const clean = cleanPlan(body, false)
  if ('error' in clean) return clean
  const count = await env.DB.prepare('SELECT COUNT(*) AS n FROM plans WHERE client_id = ?1')
    .bind(user.clientId)
    .first<{ n: number }>()
  if ((count?.n ?? 0) >= 100) return { error: 'A price list holds at most 100 plans. Retire one first.', status: 400 }
  const id = `plan_${crypto.randomUUID()}`
  const now = Date.now()
  await env.DB.prepare(
    'INSERT INTO plans (id, client_id, name, value, active, sort, created_at, updated_at) VALUES (?1,?2,?3,?4,1,?5,?6,?6)',
  )
    .bind(id, user.clientId, clean.name, clean.value, clean.sort ?? count?.n ?? 0, now)
    .run()
  return { id, name: clean.name!, value: clean.value!, active: true, sort: clean.sort ?? count?.n ?? 0 }
}

/**
 * Rename, reprice, retire or bring back a plan. Repricing changes what the
 * next sale on it is worth, not what past sales were: a sale keeps the price
 * it was made at.
 */
export async function updatePlan(env: Env, user: SessionUser, id: string, body: Record<string, unknown>): Promise<PlanDTO | Failure> {
  if (!canImport(user)) return { error: 'Not permitted.', status: 403 }
  const clean = cleanPlan(body, true)
  if ('error' in clean) return clean
  const row = await env.DB.prepare(
    `UPDATE plans SET name = COALESCE(?3, name), value = COALESCE(?4, value),
            active = COALESCE(?5, active), sort = COALESCE(?6, sort), updated_at = ?7
      WHERE id = ?1 AND client_id = ?2
      RETURNING *`,
  )
    .bind(
      id,
      user.clientId,
      clean.name ?? null,
      clean.value ?? null,
      clean.active === undefined ? null : clean.active ? 1 : 0,
      clean.sort ?? null,
      Date.now(),
    )
    .first<Record<string, unknown>>()
  if (!row) return { error: 'No such plan.', status: 404 }
  return toPlan(row)
}

/* --- the reporting roll-up ------------------------------------------------ */

/**
 * Recompute one rep's day in `daily_stats` from what happened that day.
 *
 * Counts come from the visits table, money from the sales won that day — so a
 * replayed or out-of-order batch converges on the truth, and a manager
 * correcting a sale's value moves the rep's closed money on the day it was won
 * rather than the day it was corrected.
 *
 * The day is the company's calendar (`dayRangeIn`), not the server's, and not
 * a fixed 24 hours: a day with a clock change in it is 23 or 25 hours long.
 */
export async function recomputeDailyStats(
  env: Env,
  clientId: string,
  repId: string | null,
  timezone: string,
  at: number,
): Promise<void> {
  if (!repId) return
  const day = dayKeyIn(at, timezone)
  const [dayStart, dayEnd] = dayRangeIn(day, timezone)

  const agg = await env.DB.prepare(
    `SELECT COUNT(*) AS knocks,
            SUM(CASE WHEN outcome IN ('interested','appointment','quote_requested','sold') THEN 1 ELSE 0 END) AS conversations,
            SUM(CASE WHEN outcome = 'appointment' THEN 1 ELSE 0 END) AS appointments,
            SUM(CASE WHEN outcome = 'quote_requested' THEN 1 ELSE 0 END) AS quotes,
            SUM(CASE WHEN outcome = 'sold' THEN 1 ELSE 0 END) AS sold
       FROM visits
      WHERE rep_id = ?1 AND ended_at >= ?2 AND ended_at < ?3 AND outcome IS NOT NULL`,
  )
    .bind(repId, dayStart, dayEnd)
    .first<Record<string, number>>()

  /*
    Money closed on this day, and nothing else: the sales this rep won in it
    that still stand. It used to be the imported estimate of every lead with a
    Sold visit that day; it is now what the sale itself says it was worth,
    which is that same estimate until a plan is chosen.
  */
  const value =
    (
      await env.DB.prepare(
        `SELECT COALESCE(SUM(value), 0) AS v FROM deals
          WHERE client_id = ?1 AND rep_id = ?2 AND status = 'won'
            AND won_at >= ?3 AND won_at < ?4`,
      )
        .bind(clientId, repId, dayStart, dayEnd)
        .first<{ v: number }>()
    )?.v ?? 0

  // A rep with nothing on the day and no row yet needs no row.
  if (!agg?.knocks && !value) {
    await env.DB.prepare(
      `UPDATE daily_stats SET knocks = 0, conversations = 0, appointments = 0, quotes = 0, sold = 0, pipeline_value = 0
        WHERE id = ?1`,
    )
      .bind(`${repId}:${day}`)
      .run()
    return
  }

  await env.DB.prepare(
    `INSERT INTO daily_stats
       (id, client_id, rep_id, day, knocks, conversations, appointments, quotes, sold, pipeline_value)
     VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10)
     ON CONFLICT(id) DO UPDATE SET
       knocks = excluded.knocks,
       conversations = excluded.conversations,
       appointments = excluded.appointments,
       quotes = excluded.quotes,
       sold = excluded.sold,
       pipeline_value = excluded.pipeline_value`,
  )
    .bind(
      `${repId}:${day}`,
      clientId,
      repId,
      day,
      agg?.knocks ?? 0,
      agg?.conversations ?? 0,
      agg?.appointments ?? 0,
      agg?.quotes ?? 0,
      agg?.sold ?? 0,
      value,
    )
    .run()
}
