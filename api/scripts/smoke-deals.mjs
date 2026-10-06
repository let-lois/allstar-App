import { execFileSync, spawn } from 'node:child_process'
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

/**
 * Plans and sales, against a real Worker and a real database.
 *
 * What a sale is worth used to be whatever the imported spreadsheet said, and
 * nothing in the app could change it. Now the office keeps a price list, the
 * rep picks a plan when a door says yes, the sale is a row of its own, and a
 * manager may override its value with a reason. This file walks every path
 * that opens, changes or closes a sale, and checks the money each one leaves
 * on the console:
 *
 *   - the price list: who may change it, what it refuses;
 *   - a Sold visit with a plan, and one without (the estimate counts);
 *   - a second Sold visit on the same lead is not a second sale;
 *   - a rep may change the plan, not the value; a manager may, with a reason;
 *   - Won by hand, and the office's bulk change, open sales too;
 *   - leaving Won cancels the sale and takes its money off the day;
 *   - repricing a plan does not move sales already made;
 *   - the migration backfills leads that were Won before this existed.
 */

const here = dirname(fileURLToPath(import.meta.url))
const api = resolve(here, '..')
const PORT = Number(process.env.PORT || 8840)
const BASE = `http://127.0.0.1:${PORT}`
const SETUP_TOKEN = 'local-setup-token'
const PEPPER = 'local-deals-pepper'
const STATE = resolve(api, '.wrangler/deals-smoke-state')
const CONFIG = resolve(api, '.wrangler/deals-smoke.toml')

const fails = []
const ok = (cond, msg, got) => {
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${msg}${got !== undefined ? `  (${got})` : ''}`)
  if (!cond) fails.push(msg)
}

const { Agent, setGlobalDispatcher } = await import('undici')
setGlobalDispatcher(new Agent({}))

let child = null

function writeConfig() {
  const source = readFileSync(resolve(api, 'wrangler.toml'), 'utf8')
  mkdirSync(dirname(CONFIG), { recursive: true })
  writeFileSync(CONFIG, source.replace('main = "src/index.ts"', 'main = "../src/index.ts"'))
}

async function start() {
  child = spawn(
    resolve(api, 'node_modules/.bin/wrangler'),
    [
      'dev', '-c', CONFIG,
      '--port', String(PORT), '--ip', '127.0.0.1', '--local-protocol', 'http',
      '--persist-to', STATE, '--log-level', 'warn',
      '--var', `SETUP_TOKEN:${SETUP_TOKEN}`,
      '--var', `SESSION_PEPPER:${PEPPER}`,
    ],
    { cwd: api, stdio: ['ignore', 'pipe', 'pipe'], detached: true },
  )
  child.stdout.on('data', () => {})
  child.stderr.on('data', (b) => { if (process.env.DEBUG) process.stderr.write(b) })
  for (let i = 0; i < 90; i++) {
    try {
      const res = await fetch(`${BASE}/api/health`)
      if (res.ok) return await res.json()
    } catch { /* not up yet */ }
    await new Promise((r) => setTimeout(r, 1000))
  }
  throw new Error('wrangler dev never became healthy')
}

async function stop() {
  if (!child) return
  const dead = new Promise((r) => child.once('exit', r))
  try { process.kill(-child.pid, 'SIGTERM') } catch { child.kill('SIGTERM') }
  await Promise.race([dead, new Promise((r) => setTimeout(r, 8000))])
  child = null
  for (let i = 0; i < 30; i++) {
    try { await fetch(`${BASE}/api/health`) } catch { return }
    await new Promise((r) => setTimeout(r, 500))
  }
  throw new Error(`something is still listening on ${BASE}`)
}

const call = (path, opts = {}, token) =>
  fetch(`${BASE}${path}`, {
    ...opts,
    headers: {
      'content-type': 'application/json',
      ...(token ? { authorization: `Bearer ${token}` } : {}),
      ...opts.headers,
    },
  })
const j = async (pending) => {
  const res = await pending
  return { status: res.status, body: await res.json().catch(() => ({})) }
}

/** Only with the server stopped — two processes on one SQLite file take the Worker down. */
function d1(command) {
  const out = execFileSync(
    resolve(api, 'node_modules/.bin/wrangler'),
    ['d1', 'execute', 'allstar-db', '--local', '--persist-to', STATE, '--json', '-c', CONFIG, '--command', command],
    { cwd: api, encoding: 'utf8', maxBuffer: 32 * 1024 * 1024 },
  )
  return JSON.parse(out.slice(out.indexOf('[')))[0]?.results ?? []
}

function applySchema() {
  execFileSync(
    resolve(api, 'node_modules/.bin/wrangler'),
    ['d1', 'execute', 'allstar-db', '--local', '--persist-to', STATE, '--file', './schema.sql', '-c', CONFIG, '-y'],
    { cwd: api, stdio: 'ignore' },
  )
}

const stamp = Date.now()
const OWNER = { email: `deals-${stamp}@example.com`, password: 'correct-horse-battery-55' }

/** Invite a rep and sign in as them — the production path, not a row insert. */
async function mintRep(adminToken, name) {
  const email = `${name.toLowerCase()}-${stamp}@example.com`
  const password = `${name}-password-1234`
  const invite = await (await call('/api/invites', {
    method: 'POST', body: JSON.stringify({ email, name, role: 'field_rep' }),
  }, adminToken)).json()
  await fetch(invite.url, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ password, confirm: password }),
  })
  const session = await (await call('/api/auth/login', { method: 'POST', body: JSON.stringify({ email, password }) })).json()
  return { id: session.user.id, token: session.token }
}

/* Recent days at UTC noon, so the day a sale lands on is never in doubt. */
const utcMidnight = Math.floor(Date.now() / 86_400_000) * 86_400_000
const DAY_A = utcMidnight - 3 * 86_400_000 + 12 * 3_600_000
const DAY_B = utcMidnight - 2 * 86_400_000 + 12 * 3_600_000
// The day the pre-existing Won lead was last touched — its own, so its sale
// does not land in the days the rest of this file counts.
const OLD_DAY = utcMidnight - 6 * 86_400_000 + 12 * 3_600_000
const dayKey = (ts) => new Date(ts).toISOString().slice(0, 10)

let n = 0
const push = (token, kind, payload, at = Date.now()) =>
  j(call('/api/mutations', {
    method: 'POST',
    body: JSON.stringify({ mutations: [{ id: `m_${stamp}_${++n}`, kind, createdAt: at, payload }] }),
  }, token)).then((r) => r.body.results?.[0])

const visit = async (token, propertyId, at, outcome, extra = {}) => {
  const id = `v_${stamp}_${++n}`
  await push(token, 'visit.start', { id, propertyId, startedAt: at }, at)
  return push(token, 'visit.complete', { id, propertyId, startedAt: at, endedAt: at, outcome, ...extra }, at)
}

try {
  rmSync(STATE, { recursive: true, force: true })
  writeConfig()

  /* --- a lead Won before any of this existed, for the backfill ----------- */
  await start()
  applySchema()
  await stop()
  const health = await start()
  ok(health.config?.migrations?.state !== 'failed', 'the database is ready')

  await call('/setup', {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ token: SETUP_TOKEN, clientName: 'Deal Co', name: 'Owner', email: OWNER.email, password: OWNER.password }),
  })
  const login = await (await call('/api/auth/login', { method: 'POST', body: JSON.stringify(OWNER) })).json()
  const admin = login.token
  const clientId = login.user?.clientId
  const ownerId = login.user?.id
  ok(!!admin && !!clientId, 'the owner can sign in')
  const rep = await mintRep(admin, 'Rhea')
  ok(!!rep.token, 'a field rep can sign in')

  await stop()
  const leads = { a: 9_000, b: 7_000, c: 11_000, d: 5_000, e: 4_000, f: 3_000, g: 2_000, h: 1_500, old: 6_500 }
  for (const [k, v] of Object.entries(leads)) {
    d1(`INSERT INTO properties (id, client_id, address1, lat, lng, status, score, opportunity_value, assigned_rep_id, updated_at)
        VALUES ('p_${k}','${clientId}','${k} Plan St',30.51,-97.67,'${k === 'old' ? 'won' : 'working'}',50,${v},'${rep.id}',${k === 'old' ? OLD_DAY : DAY_A})`)
  }
  // Rerun the migration's backfill as a pre-existing database would: drop its
  // ledger row and let the Worker apply it on boot.
  d1(`DELETE FROM schema_migrations WHERE id = '027-plans-deals'`)
  await start()

  const boot = async (token) => (await j(call('/api/bootstrap', {}, token))).body
  const prop = async (token, id) => (await boot(token)).properties.find((p) => p.id === id)
  const stats = async (repId = rep.id) =>
    Object.fromEntries((await boot(admin)).dailyStats.filter((s) => s.repId === repId).map((s) => [s.day, s]))

  {
    const old = await prop(admin, 'p_old')
    ok(old?.deal?.value === leads.old, 'a lead Won before plans existed has a sale, at its imported value', old?.deal?.value)
    ok(old?.deal?.repId === rep.id, 'credited to its rep', old?.deal?.repId)
  ok(old?.deal?.wonAt === OLD_DAY, 'on the day it was last changed, having no Sold visit', old?.deal?.wonAt)
  }

  /* --- the price list ---------------------------------------------------- */
  const standard = await j(call('/api/plans', { method: 'POST', body: JSON.stringify({ name: 'Standard', value: 15_000 }) }, admin))
  const premium = await j(call('/api/plans', { method: 'POST', body: JSON.stringify({ name: 'Premium', value: 24_000 }) }, admin))
  ok(standard.status === 201 && premium.status === 201, 'the office adds plans', `${standard.status}/${premium.status}`)
  const STD = standard.body.plan?.id
  const PRE = premium.body.plan?.id
  ok((await j(call('/api/plans', { method: 'POST', body: JSON.stringify({ name: '', value: 10 }) }, admin))).status === 400, 'a plan needs a name')
  ok((await j(call('/api/plans', { method: 'POST', body: JSON.stringify({ name: 'Bad', value: -5 }) }, admin))).status === 400, 'and a price that is not negative')
  ok((await j(call('/api/plans', { method: 'POST', body: JSON.stringify({ name: 'Rogue', value: 1 }) }, rep.token))).status === 403, 'a rep cannot add a plan')
  ok((await j(call(`/api/plans/${STD}`, { method: 'PATCH', body: JSON.stringify({ value: 1 }) }, rep.token))).status === 403, 'nor reprice one')
  const repPlans = (await boot(rep.token)).plans ?? []
  ok(repPlans.length === 2 && repPlans.some((p) => p.id === STD), 'but every rep gets the price list on their phone', repPlans.length)

  /* --- Sold at the door, on a plan --------------------------------------- */
  await visit(rep.token, 'p_a', DAY_A, 'sold', { deal: { planId: STD } })
  let a = await prop(rep.token, 'p_a')
  ok(a?.status === 'won' && a?.deal?.value === 15_000, 'a Sold visit on a plan opens a sale at the plan price', a?.deal?.value)
  ok(a?.deal?.planName === 'Standard' && a?.deal?.wonAt === DAY_A, 'naming the plan and the moment it was won')
  let day = (await stats())[dayKey(DAY_A)]
  ok(day?.closedValue === 15_000 && day?.sold === 1, "the day's closed money is the sale's value", day?.closedValue)

  /* --- Sold without a plan: the estimate counts -------------------------- */
  await visit(rep.token, 'p_b', DAY_A, 'sold')
  const b = await prop(rep.token, 'p_b')
  ok(b?.deal?.value === leads.b && !b?.deal?.planId, 'with no plan picked the sale counts at the estimate', b?.deal?.value)
  day = (await stats())[dayKey(DAY_A)]
  ok(day?.closedValue === 15_000 + leads.b, 'and adds to the day', day?.closedValue)

  /* --- a second Sold visit is not a second sale -------------------------- */
  await visit(rep.token, 'p_a', DAY_B, 'sold')
  a = await prop(rep.token, 'p_a')
  ok(a?.deal?.wonAt === DAY_A && a?.deal?.value === 15_000, 'a second Sold visit leaves the sale where it was', a?.deal?.wonAt === DAY_A)
  ok(((await stats())[dayKey(DAY_B)]?.closedValue ?? 0) === 0, 'and puts no money on the second day')

  /* --- a rep picks the plan later; only a manager sets a value ----------- */
  let r = await push(rep.token, 'deal.update', { propertyId: 'p_b', planId: PRE })
  ok(r?.status === 'applied', 'a rep can choose the plan afterwards', r?.status)
  ok((await prop(rep.token, 'p_b'))?.deal?.value === 24_000, 'and the sale takes its price')
  r = await push(rep.token, 'deal.update', { propertyId: 'p_b', value: 99_000, reason: 'trust me' })
  ok(r?.status !== 'applied' && (await prop(admin, 'p_b'))?.deal?.value === 24_000, 'a rep cannot set the value', r?.status)
  r = await push(admin, 'deal.update', { propertyId: 'p_b', value: 20_000 })
  ok(r?.status !== 'applied', 'a manager must say why', r?.status)
  r = await push(admin, 'deal.update', { propertyId: 'p_b', value: 20_000, reason: 'Loyalty discount' })
  const bb = await prop(admin, 'p_b')
  ok(r?.status === 'applied' && bb?.deal?.value === 20_000, 'a manager can, with a reason', bb?.deal?.value)
  ok(bb?.deal?.overrideReason === 'Loyalty discount' && bb?.deal?.overriddenBy === ownerId && bb?.deal?.planValue === 24_000, 'which is kept beside the plan price and who set it')
  day = (await stats())[dayKey(DAY_A)]
  ok(day?.closedValue === 15_000 + 20_000, "the change moves the money on the day the sale was won", day?.closedValue)
  const activity = (await boot(admin)).activity.filter((e) => e.propertyId === 'p_b' && e.type === 'deal')
  ok(activity.some((e) => /Loyalty discount/.test(e.summary)), 'and the lead\'s activity says why the number moved')
  r = await push(admin, 'deal.update', { propertyId: 'p_c', planId: STD })
  ok(r?.status !== 'applied', 'a lead that is not Won has no sale to change', r?.status)

  /* --- repricing a plan does not move past sales ------------------------- */
  const repriced = await j(call(`/api/plans/${STD}`, { method: 'PATCH', body: JSON.stringify({ value: 16_000 }) }, admin))
  ok(repriced.status === 200 && repriced.body.plan?.value === 16_000, 'the office can reprice a plan')
  ok((await prop(admin, 'p_a'))?.deal?.value === 15_000, 'and a sale already made keeps the price it was made at')

  /* --- Won by hand, and by the office in bulk ---------------------------- */
  r = await push(rep.token, 'property.status', { id: 'p_c', status: 'won' })
  const c = await prop(admin, 'p_c')
  ok(r?.status === 'applied' && c?.deal?.value === leads.c && c?.deal?.repId === rep.id, 'Won by hand opens a sale too, credited to the lead\'s rep', c?.deal?.value)
  const bulk = await j(call('/api/leads/status', { method: 'POST', body: JSON.stringify({ propertyIds: ['p_d', 'p_a'], status: 'won' }) }, admin))
  const d = await prop(admin, 'p_d')
  ok(bulk.status === 200 && d?.deal?.value === leads.d, 'the office setting leads to Won in bulk opens their sales', `${bulk.status} ${d?.deal?.value}`)
  ok((await prop(admin, 'p_a'))?.deal?.wonAt === DAY_A, 'and leaves a lead already sold exactly as it was')

  /* --- leaving Won cancels the sale -------------------------------------- */
  await visit(rep.token, 'p_a', DAY_B, 'not_interested')
  a = await prop(admin, 'p_a')
  ok(a?.status === 'lost' && !a?.deal, 'an outcome that moves a sold lead elsewhere cancels its sale')
  day = (await stats())[dayKey(DAY_A)]
  ok(day?.closedValue === 20_000, "and takes its money off the day it was won", day?.closedValue)
  await j(call('/api/leads/status', { method: 'POST', body: JSON.stringify({ propertyIds: ['p_d'], status: 'working' }) }, admin))
  ok(!(await prop(admin, 'p_d'))?.deal, 'the office moving a lead off Won cancels it too')
  // Re-won: the same row, a new moment, no double count.
  await visit(rep.token, 'p_a', DAY_B, 'sold', { deal: { planId: PRE } })
  a = await prop(admin, 'p_a')
  ok(a?.deal?.value === 24_000 && a?.deal?.wonAt === DAY_B, 'a lead sold again gets a fresh sale on the new day', a?.deal?.value)
  const all = await stats()
  ok(all[dayKey(DAY_A)]?.closedValue === 20_000 && all[dayKey(DAY_B)]?.closedValue === 24_000, 'counted once, on the day it was sold again', `${all[dayKey(DAY_A)]?.closedValue}/${all[dayKey(DAY_B)]?.closedValue}`)

  /* --- a retired plan is not offered for a new sale ---------------------- */
  await j(call(`/api/plans/${PRE}`, { method: 'PATCH', body: JSON.stringify({ active: false }) }, admin))
  await visit(rep.token, 'p_e', DAY_B, 'sold', { deal: { planId: PRE } })
  const e = await prop(admin, 'p_e')
  ok(e?.deal?.value === leads.e && !e?.deal?.planId, 'a retired plan is ignored for a new sale', e?.deal?.planId)
  ok((await prop(admin, 'p_a'))?.deal?.planName === 'Premium', 'while sales already on it keep its name')

  /* --- the spreadsheet --------------------------------------------------- */
  const csv = await (await call('/api/leads/export.csv', {}, admin)).text()
  const header = csv.split('\r\n')[0].split(',')
  const row = csv.split('\r\n').find((l) => l.startsWith('p_a,'))?.split(',') ?? []
  ok(row[header.indexOf('sale_plan')] === 'Premium' && row[header.indexOf('sale_value')] === '24000', 'the export carries the sale', `${row[header.indexOf('sale_plan')]} ${row[header.indexOf('sale_value')]}`)

  /* --- a plan on a lead that is not sold yet ----------------------------- */
  r = await push(rep.token, 'property.plan', { id: 'p_f', planId: STD })
  let f = await prop(rep.token, 'p_f')
  ok(r?.status === 'applied' && f?.plan?.id === STD && f?.plan?.value === 16_000, 'a rep can put an open lead on a plan', JSON.stringify(f?.plan))
  ok(!f?.deal, 'which does not make it a sale')
  ok((await boot(admin)).activity.some((e) => e.propertyId === 'p_f' && /Plan set to Standard/.test(e.summary)), "and the lead's activity says so")
  r = await push(rep.token, 'property.plan', { id: 'p_f', planId: PRE })
  ok(r?.status !== 'applied' && (await prop(admin, 'p_f'))?.plan?.id === STD, 'a retired plan cannot be put on a lead', r?.status)

  // Sold with no plan picked at the door: the sale takes the lead's plan.
  await push(rep.token, 'property.plan', { id: 'p_g', planId: STD })
  await visit(rep.token, 'p_g', DAY_B, 'sold')
  const g = await prop(admin, 'p_g')
  ok(g?.deal?.planId === STD && g?.deal?.value === 16_000, "a lead sold without a plan picked is sold on the plan it carries", g?.deal?.value)
  // "Not sure" said out loud at the door: no plan, the estimate counts.
  await push(rep.token, 'property.plan', { id: 'p_h', planId: STD })
  await visit(rep.token, 'p_h', DAY_B, 'sold', { deal: { planId: null } })
  const h = await prop(admin, 'p_h')
  ok(!h?.deal?.planId && h?.deal?.value === leads.h, '"Not sure" at the door means no plan, even on a lead that had one', h?.deal?.value)
  // Choosing a plan for a sold lead from the lead moves the sale onto it.
  await push(rep.token, 'property.plan', { id: 'p_h', planId: STD })
  ok((await prop(admin, 'p_h'))?.deal?.value === 16_000, "putting a sold lead on a plan moves its sale onto that plan's price")
  r = await push(rep.token, 'property.plan', { id: 'p_f', planId: null })
  f = await prop(admin, 'p_f')
  ok(r?.status === 'applied' && !f?.plan, 'and a lead can be taken off its plan')
  await push(rep.token, 'property.plan', { id: 'p_f', planId: STD })

  /* --- deleting a plan --------------------------------------------------- */
  ok((await j(call(`/api/plans/${STD}`, { method: 'DELETE' }, rep.token))).status === 403, 'a rep cannot delete a plan')
  const del = await j(call(`/api/plans/${STD}`, { method: 'DELETE' }, admin))
  ok(del.status === 200 && del.body.leads >= 1 && del.body.sales >= 1, 'the office can delete one, and is told what it touched', JSON.stringify(del.body))
  const after = await boot(admin)
  ok(!(after.plans ?? []).some((pl) => pl.id === STD), 'it is gone from the price list')
  f = after.properties.find((p) => p.id === 'p_f')
  ok(!f?.plan, 'leads that carried it go back to no plan')
  const gAfter = after.properties.find((p) => p.id === 'p_g')
  ok(gAfter?.deal?.planName === 'Standard' && gAfter?.deal?.value === 16_000 && !gAfter?.deal?.planId, 'a sale made on it keeps its name and price', JSON.stringify(gAfter?.deal))
  ok((await j(call(`/api/plans/${STD}`, { method: 'DELETE' }, admin))).status === 404, 'and deleting it twice says there is no such plan')
} finally {
  await stop().catch(() => {})
  rmSync(CONFIG, { force: true })
  rmSync(STATE, { recursive: true, force: true })
}

console.log(fails.length ? `\n${fails.length} deal check(s) failed` : '\n=== plans and sales OK ===')
process.exit(fails.length ? 1 : 0)
