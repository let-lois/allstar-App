import { spawn } from 'node:child_process'
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

/**
 * Lead lists, end to end: a manager draws round forty houses, names the list,
 * hands it to three people — and those three see the houses on their phones.
 *
 * The last clause is the one that matters and the one that changed the data
 * model. A rep's bootstrap was `assigned_rep_id = me`, full stop; a list handed
 * to three reps means three phones need the same houses while each house still
 * has one assignee. So the scope became "assigned to me, OR on a live list
 * assigned to me", and every assertion here about what a rep *sees* is really
 * an assertion about that predicate — which also decides what a rep may *add*
 * to a list, from the same SQL, so the two cannot drift.
 *
 * Against a real Worker and a real database, because visibility is exactly the
 * property that a unit test of one function cannot see.
 *
 * What it asserts, in the order the failures would hurt:
 *
 *   a rep with nothing assigned sees nothing — the control
 *   a rep cannot draw an area or assign reps; a manager can
 *   the drawn list claims exactly the houses inside the shape
 *   every assigned rep now sees those houses; an unassigned rep does not
 *   archiving a list takes its houses off the phones; restoring brings them back
 *   reassignment is one action — the old reps lose, the new one gains
 *   a rep can make their own list over their own leads, and only their own
 *   a rep cannot assign reps to anything, including their own list
 *   the same functions serve the offline path — created, edited, refused alike
 *   a retried offline create is a duplicate, not an error and not a second row
 *   another tenant's list is unreachable by id and absent from every listing
 *   delete cascades, and the audit log knows who did what
 */

const here = dirname(fileURLToPath(import.meta.url))
const api = resolve(here, '..')
const PORT = Number(process.env.PORT || 8851)
const BASE = `http://127.0.0.1:${PORT}`
const SETUP_TOKEN = 'local-setup-token'
const STATE = resolve(api, '.wrangler/lists-state')

const fails = []
const ok = (cond, msg, measured) => {
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${msg}${measured ? `  (${measured})` : ''}`)
  if (!cond) fails.push(msg)
}

function writeConfig(name) {
  const source = readFileSync(resolve(api, 'wrangler.toml'), 'utf8')
  const body = source.replace('main = "src/index.ts"', 'main = "../src/index.ts"')
  const path = resolve(api, '.wrangler', name)
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, body)
  return path
}

let child = null
async function start(config) {
  child = spawn(resolve(api, 'node_modules/.bin/wrangler'),
    ['dev', '-c', config, '--port', String(PORT), '--ip', '127.0.0.1',
     '--local-protocol', 'http', '--persist-to', STATE, '--log-level', 'warn',
     '--var', `SETUP_TOKEN:${SETUP_TOKEN}`,
     '--var', 'SESSION_PEPPER:local-lists-pepper'],
    { cwd: api, stdio: ['ignore', 'pipe', 'pipe'], detached: true })
  child.stdout.on('data', () => {})
  child.stderr.on('data', () => {})
  for (let i = 0; i < 90; i++) {
    try { const r = await fetch(`${BASE}/api/health`); if (r.ok) return await r.json() } catch {}
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
}
async function applySchema(config) {
  await new Promise((done, fail) => {
    const p = spawn(resolve(api, 'node_modules/.bin/wrangler'),
      ['d1', 'execute', 'allstar-db', '--local', '--persist-to', STATE, '--file', './schema.sql', '-c', config, '-y'],
      { cwd: api, stdio: 'ignore' })
    p.on('exit', (c) => (c === 0 ? done() : fail(new Error(`d1 execute exited ${c}`))))
  })
}
const call = (path, opts = {}, token) =>
  fetch(`${BASE}${path}`, {
    ...opts,
    headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}), ...opts.headers },
  })
const j = async (res) => ({ status: res.status, body: await res.json().catch(() => ({})) })
async function query(sql) {
  const { execFile } = await import('node:child_process')
  const { promisify } = await import('node:util')
  const run = promisify(execFile)
  const { stdout } = await run(resolve(api, 'node_modules/.bin/wrangler'),
    ['d1', 'execute', 'allstar-db', '--local', '--persist-to', STATE, '--json', '--command', sql],
    { cwd: api, maxBuffer: 8 * 1024 * 1024 })
  return JSON.parse(stdout.slice(stdout.indexOf('[')))[0]?.results ?? []
}
const n = (rows) => Number(rows[0] ? Object.values(rows[0])[0] : -1)

const stamp = Date.now()
const OWNER = { email: `lists-owner-${stamp}@example.com`, password: 'correct-horse-battery-99' }

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
  return { id: session.user.id, token: session.token, name }
}

/** A rep's phone, as bootstrap would fill it. */
const phone = async (token) => {
  const b = await (await call('/api/bootstrap', {}, token)).json()
  return {
    leads: new Set((b.properties ?? []).map((p) => p.id)),
    lists: b.leadLists ?? [],
  }
}

// A box in Round Rock. Four houses inside, two well outside.
const BOX = [
  { lat: 30.500, lng: -97.680 },
  { lat: 30.520, lng: -97.680 },
  { lat: 30.520, lng: -97.660 },
  { lat: 30.500, lng: -97.660 },
]
const ROWS = [
  { ref: 'in1', address1: '10 Inside St', city: 'Round Rock', state: 'TX', zip: '78664', lat: 30.505, lng: -97.675 },
  { ref: 'in2', address1: '12 Inside St', city: 'Round Rock', state: 'TX', zip: '78664', lat: 30.510, lng: -97.670 },
  { ref: 'in3', address1: '14 Inside St', city: 'Round Rock', state: 'TX', zip: '78664', lat: 30.515, lng: -97.665 },
  { ref: 'in4', address1: '16 Inside St', city: 'Round Rock', state: 'TX', zip: '78664', lat: 30.518, lng: -97.662 },
  { ref: 'out1', address1: '1 Outside Ave', city: 'Round Rock', state: 'TX', zip: '78664', lat: 30.600, lng: -97.600 },
  { ref: 'out2', address1: '3 Outside Ave', city: 'Round Rock', state: 'TX', zip: '78664', lat: 30.400, lng: -97.700 },
]

try {
  rmSync(STATE, { recursive: true, force: true })
  const config = writeConfig('lists-smoke.toml')
  await start(config)
  await applySchema(config)
  await stop()
  await start(config)

  await call('/setup', {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ token: SETUP_TOKEN, clientName: 'Summit Exteriors', name: 'Owner', email: OWNER.email, password: OWNER.password }),
  })
  const { token: manager, user: owner } = await (await call('/api/auth/login', { method: 'POST', body: JSON.stringify(OWNER) })).json()
  ok(!!manager, 'a manager is signed in')

  const [matthew, john, sarah] = await Promise.all([mintRep(manager, 'Matthew'), mintRep(manager, 'John'), mintRep(manager, 'Sarah')])
  ok(!!matthew.token && !!john.token && !!sarah.token, 'three reps exist and can sign in')

  const imported = await (await call('/api/import/properties', { method: 'POST', body: JSON.stringify({ rows: ROWS }) }, manager)).json()
  ok(imported.created === 6, 'six leads imported with coordinates, assigned to nobody', `${imported.created}`)
  const byRef = Object.fromEntries(ROWS.map((r, i) => [r.ref, imported.ids[i]]))
  const insideIds = ['in1', 'in2', 'in3', 'in4'].map((r) => byRef[r])
  const outsideIds = ['out1', 'out2'].map((r) => byRef[r])

  /* ===== 1. the control ================================================== */
  {
    const m = await phone(matthew.token)
    ok(m.leads.size === 0 && m.lists.length === 0, 'a rep with nothing assigned sees no leads and no lists — the control')
  }

  /* ===== 2. what a rep may not do ========================================= */
  {
    const drawn = await j(await call('/api/lists', { method: 'POST', body: JSON.stringify({ name: 'Nope', boundary: BOX }) }, matthew.token))
    ok(drawn.status === 403, 'a rep cannot draw a list round an area', `${drawn.status} ${drawn.body.error ?? ''}`)
    const handed = await j(await call('/api/lists', { method: 'POST', body: JSON.stringify({ name: 'Nope', repIds: [john.id] }) }, matthew.token))
    ok(handed.status === 403, 'nor hand a list to another rep', `${handed.status}`)
  }

  /* ===== 3. the manager draws round the block ============================= */
  let LIST = null
  {
    const r = await j(await call('/api/lists', {
      method: 'POST',
      body: JSON.stringify({ name: 'Northwest Territory – Sept 10', description: 'Storm canvass', boundary: BOX, repIds: [matthew.id, john.id] }),
    }, manager))
    ok(r.status === 201, 'a manager creates a list from a drawn area', `${r.status} ${r.body.error ?? ''}`)
    LIST = r.body.list
    ok(LIST?.leadIds?.length === 4, 'and it claims exactly the houses inside the shape', `${LIST?.leadIds?.length} of 6`)
    ok(insideIds.every((id) => LIST?.leadIds?.includes(id)) && !outsideIds.some((id) => LIST?.leadIds?.includes(id)), 'the right four')
    ok(LIST?.repIds?.length === 2 && LIST.repIds.includes(matthew.id) && LIST.repIds.includes(john.id), 'assigned to the two reps named')
    ok(Array.isArray(LIST?.boundary) && LIST.boundary.length === 4, 'and remembers the shape it was drawn from')
  }

  /* ===== 4. the reps see the houses ======================================= */
  {
    const [m, jn, s] = await Promise.all([phone(matthew.token), phone(john.token), phone(sarah.token)])
    ok(m.leads.size === 4 && insideIds.every((id) => m.leads.has(id)), 'Matthew now sees the four houses on his phone', `${m.leads.size}`)
    ok(jn.leads.size === 4, 'and so does John — the same houses, two phones', `${jn.leads.size}`)
    ok(m.lists.length === 1 && m.lists[0].name === 'Northwest Territory – Sept 10' && m.lists[0].leadIds.length === 4, 'with the list itself, members included')
    ok(s.leads.size === 0 && s.lists.length === 0, 'Sarah, not assigned, sees none of it', `${s.leads.size}`)
    ok(!m.leads.has(outsideIds[0]), 'and nobody was handed the houses outside the shape')
  }

  /* ===== 5. the manager's view ============================================ */
  {
    const r = await j(await call('/api/lists', {}, manager))
    const mine = r.body.lists?.find((l) => l.id === LIST.id)
    ok(!!mine && mine.leadIds.length === 4 && mine.repIds.length === 2, 'the manager sees the list with its count and its reps')
    const dup = await j(await call('/api/lists', { method: 'POST', body: JSON.stringify({ name: 'northwest territory – sept 10', propertyIds: [] }) }, manager))
    ok(dup.status === 409, 'a second list with the same name is refused, whatever its case', `${dup.status}`)
  }

  /* ===== 6. archive takes it off the phones; restore brings it back ======== */
  {
    const a = await j(await call(`/api/lists/${LIST.id}`, { method: 'PATCH', body: JSON.stringify({ archived: true }) }, manager))
    ok(a.status === 200, 'the manager archives the list')
    const m = await phone(matthew.token)
    ok(m.leads.size === 0 && m.lists.length === 0, 'an archived list confers nothing — the houses leave the phone', `${m.leads.size} leads`)
    await call(`/api/lists/${LIST.id}`, { method: 'PATCH', body: JSON.stringify({ archived: false }) }, manager)
    const back = await phone(matthew.token)
    ok(back.leads.size === 4, 'and restoring it brings them back', `${back.leads.size}`)
  }

  /* ===== 7. reassignment is one action ==================================== */
  {
    const r = await j(await call(`/api/lists/${LIST.id}/reps`, { method: 'PUT', body: JSON.stringify({ repIds: [sarah.id] }) }, manager))
    ok(r.status === 200 && r.body.repIds?.length === 1, 'the manager reassigns the list to Sarah alone', `${r.status}`)
    const [m, s] = await Promise.all([phone(matthew.token), phone(sarah.token)])
    ok(m.leads.size === 0, 'Matthew loses the houses', `${m.leads.size}`)
    ok(s.leads.size === 4 && s.lists.length === 1, 'Sarah gains them', `${s.leads.size}`)
    const stranger = await j(await call(`/api/lists/${LIST.id}/reps`, { method: 'PUT', body: JSON.stringify({ repIds: ['u_not_on_this_team'] }) }, manager))
    ok(stranger.status === 400, 'a person from outside the team cannot be assigned', `${stranger.status}`)
  }

  /* ===== 8. a rep's own list, over their own leads ========================= */
  let MONDAY = null
  {
    const r = await j(await call('/api/lists', {
      method: 'POST', body: JSON.stringify({ name: 'Monday Route', propertyIds: [insideIds[0], insideIds[1]] }),
    }, sarah.token))
    ok(r.status === 201 && r.body.list?.leadIds?.length === 2 && r.body.skipped === 0, 'Sarah makes her own list from houses she can see', `${r.status} ${r.body.skipped} skipped`)
    MONDAY = r.body.list
    const reach = await j(await call(`/api/lists/${MONDAY.id}/members`, { method: 'POST', body: JSON.stringify({ add: [outsideIds[0]] }) }, sarah.token))
    ok(reach.status === 200 && reach.body.added === 0 && reach.body.skipped === 1, 'but cannot put a house she cannot see on it — told, not silently short', JSON.stringify(reach.body))
    const grow = await j(await call(`/api/lists/${MONDAY.id}/members`, { method: 'POST', body: JSON.stringify({ add: [insideIds[2]], remove: [insideIds[0]] }) }, sarah.token))
    ok(grow.body.added === 1 && grow.body.removed === 1, 'and can add and remove her own houses in one call', JSON.stringify(grow.body))
    const assign = await j(await call(`/api/lists/${MONDAY.id}/reps`, { method: 'PUT', body: JSON.stringify({ repIds: [john.id] }) }, sarah.token))
    ok(assign.status === 403, 'a rep cannot assign reps to anything, her own list included', `${assign.status}`)
    const rename = await j(await call(`/api/lists/${MONDAY.id}`, { method: 'PATCH', body: JSON.stringify({ name: 'Monday Route (west)' }) }, sarah.token))
    ok(rename.status === 200, 'she can rename it')
    const other = await j(await call(`/api/lists/${MONDAY.id}`, { method: 'PATCH', body: JSON.stringify({ name: 'Hijacked' }) }, john.token))
    ok(other.status === 403, 'John cannot rename Sarah\'s list', `${other.status}`)
    const mgr = await j(await call('/api/lists', {}, manager))
    ok(mgr.body.lists?.some((l) => l.id === MONDAY.id), 'the manager can see the list Sarah made — managers see everything')
  }

  /* ===== 9. the offline path is the same code ============================= */
  {
    const mut = (kind, payload, id) => ({ id, kind, payload, createdAt: Date.now() })
    const r1 = await j(await call('/api/mutations', {
      method: 'POST',
      body: JSON.stringify({ mutations: [
        mut('list.create', { id: 'll_offline_followups', name: 'Follow Ups', propertyIds: [insideIds[3]] }, 'm1'),
        mut('list.members', { id: 'll_offline_followups', add: [insideIds[2]] }, 'm2'),
        mut('list.reps', { id: 'll_offline_followups', repIds: [john.id] }, 'm3'),
      ] }),
    }, sarah.token))
    const by = Object.fromEntries((r1.body.results ?? []).map((x) => [x.id, x]))
    ok(by.m1?.status === 'applied', 'a list made offline is applied on sync', by.m1?.status)
    ok(by.m2?.status === 'applied', 'and houses added offline land on it', by.m2?.status)
    ok(by.m3?.status === 'rejected' && /Not permitted/.test(by.m3?.error ?? ''), 'a rep assigning reps offline is refused, same as online', `${by.m3?.status}: ${by.m3?.error}`)
    const s = await phone(sarah.token)
    const fu = s.lists.find((l) => l.id === 'll_offline_followups')
    ok(fu?.leadIds?.length === 2, 'and her phone gets the list back with both houses', `${fu?.leadIds?.length}`)

    // The retry. A phone that lost the reply sends the same create again.
    const r2 = await j(await call('/api/mutations', {
      method: 'POST',
      body: JSON.stringify({ mutations: [mut('list.create', { id: 'll_offline_followups', name: 'Follow Ups', propertyIds: [insideIds[3]] }, 'm4')] }),
    }, sarah.token))
    const again = r2.body.results?.[0]
    ok(again?.status === 'applied' || again?.status === 'duplicate', 'sending the same create twice is not an error', again?.status)
    ok(n(await query(`SELECT COUNT(*) FROM lead_lists WHERE name='Follow Ups'`)) === 1, 'and does not make a second list')
  }

  /* ===== 10. another tenant's list does not exist, as far as we can tell === */
  {
    await query(`INSERT INTO clients (id, name, created_at) VALUES ('c_other_${stamp}', 'Somebody Else', ${stamp})`).catch(() => {})
    await query(`INSERT INTO lead_lists (id, client_id, name, archived, created_at, updated_at) VALUES ('ll_theirs_${stamp}', 'c_other_${stamp}', 'Their List', 0, ${stamp}, ${stamp})`)
    const seen = await j(await call('/api/lists', {}, manager))
    ok(!seen.body.lists?.some((l) => l.id === `ll_theirs_${stamp}`), 'a list belonging to another company is absent from the listing')
    const touch = await j(await call(`/api/lists/ll_theirs_${stamp}`, { method: 'PATCH', body: JSON.stringify({ name: 'Ours now' }) }, manager))
    ok(touch.status === 404, 'and unreachable by id — not 403, because it does not exist for this tenant', `${touch.status}`)
  }

  /* ===== 11. delete cascades; the audit log knows ========================== */
  {
    const before = n(await query(`SELECT COUNT(*) FROM lead_list_members WHERE list_id='${MONDAY.id}'`))
    const d = await j(await call(`/api/lists/${MONDAY.id}`, { method: 'DELETE' }, manager))
    ok(d.status === 200, 'the manager deletes a list')
    const after = n(await query(`SELECT COUNT(*) FROM lead_list_members WHERE list_id='${MONDAY.id}'`))
    ok(before > 0 && after === 0, 'and its memberships go with it', `${before} → ${after}`)
    const created = n(await query(`SELECT COUNT(*) FROM audit_log WHERE action='list.created' AND actor_id='${owner.id}'`))
    const assigned = n(await query(`SELECT COUNT(*) FROM audit_log WHERE action='list.assigned'`))
    ok(created >= 1 && assigned >= 1, 'the audit log records who created and who assigned', `${created} created, ${assigned} assigned`)
  }
} finally {
  await stop().catch(() => {})
}

if (fails.length) {
  console.log(`\n${fails.length} failed:`)
  fails.forEach((f) => console.log(`  - ${f}`))
  process.exit(1)
}
console.log('\n=== a manager hands a block to three people, and three phones get the houses ===')
