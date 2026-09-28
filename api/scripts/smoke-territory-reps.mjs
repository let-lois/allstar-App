import { spawn } from 'node:child_process'
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

/**
 * Many reps on a territory, on a real Worker over a real D1.
 *
 * The unit gate (`verify:territory-reps`) proves what `assignTerritory` asks
 * the database to do. This proves what three phones actually receive after it
 * has done it — the bootstrap that `repScopeSql` scopes, with `territory_reps`
 * in it — plus the one thing no fake can: that the migration made the table
 * and that a delete cascades through it. Same shape as `smoke:lists`, its own
 * port, its own database.
 *
 * What is pinned:
 *   drawing a patch with one rep hands them the unclaimed houses inside
 *   adding a second rep keeps the first, and every house they were working
 *   both reps see every house in the patch; a third rep on the team sees none
 *   taking a rep off leaves them the houses they were working, and no more
 *   the "Unassigned" choice is the only action that empties the patch
 *   a rep on a patch may edit a house in it that somebody else is working
 */

const here = dirname(fileURLToPath(import.meta.url))
const api = resolve(here, '..')
const PORT = Number(process.env.PORT || 8852)
const BASE = `http://127.0.0.1:${PORT}`
const SETUP_TOKEN = 'local-setup-token'
const STATE = resolve(api, '.wrangler/territory-reps-state')

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
     '--var', 'SESSION_PEPPER:local-treps-pepper'],
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
const OWNER = { email: `treps-owner-${stamp}@example.com`, password: 'correct-horse-battery-99' }

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

/** Who each house is assigned to, as the office sees it. */
const owners = async (managerToken) => {
  const b = await (await call('/api/bootstrap', {}, managerToken)).json()
  return Object.fromEntries((b.properties ?? []).map((p) => [p.id, p.assignedRepId ?? null]))
}

try {
  rmSync(STATE, { recursive: true, force: true })
  const config = writeConfig('territory-reps-smoke.toml')
  await start(config)
  await applySchema(config)
  await stop()
  await start(config)

  await call('/setup', {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ token: SETUP_TOKEN, clientName: 'Summit Exteriors', name: 'Owner', email: OWNER.email, password: OWNER.password }),
  })
  const { token: manager } = await (await call('/api/auth/login', { method: 'POST', body: JSON.stringify(OWNER) })).json()
  ok(!!manager, 'a manager is signed in')

  const [curtis, matthew, sarah] = await Promise.all([mintRep(manager, 'Curtis'), mintRep(manager, 'Matthew'), mintRep(manager, 'Sarah')])
  ok(!!curtis.token && !!matthew.token && !!sarah.token, 'three reps exist and can sign in')

  const imported = await (await call('/api/import/properties', { method: 'POST', body: JSON.stringify({ rows: ROWS }) }, manager)).json()
  ok(imported.created === 6, 'six houses imported, assigned to nobody', `${imported.created}`)
  const byRef = Object.fromEntries(ROWS.map((r, i) => [r.ref, imported.ids[i]]))
  const insideIds = ['in1', 'in2', 'in3', 'in4'].map((r) => byRef[r])

  ok(n(await query("SELECT COUNT(*) FROM sqlite_master WHERE type='table' AND name='territory_reps'")) === 1, 'the migration made territory_reps')

  /* ===== 1. one rep draws the patch ======================================= */
  let T = null
  {
    const r = await j(await call('/api/territories', { method: 'POST', body: JSON.stringify({ name: 'Territory A', repIds: [curtis.id], boundary: BOX }) }, manager))
    ok(r.status === 201, 'a manager draws Territory A with Curtis on it', `${r.status} ${r.body.error ?? ''}`)
    T = r.body.territory
    ok(r.body.assigned === 4 && T?.repIds?.length === 1, 'it claims the four houses inside, and names its one rep', `${r.body.assigned} leads, ${T?.repIds?.length} reps`)
    const own = await owners(manager)
    ok(insideIds.every((id) => own[id] === curtis.id), 'as the only rep, Curtis is handed all four')
    const c = await phone(curtis.token)
    ok(c.leads.size === 4, 'and sees them on his phone', `${c.leads.size}`)
  }

  /* ===== 2. Matthew joins; Curtis keeps everything ========================= */
  {
    const r = await j(await call('/api/territories/assign', { method: 'POST', body: JSON.stringify({ territoryId: T.id, repId: matthew.id, action: 'add' }) }, manager))
    ok(r.status === 200 && r.body.repIds?.length === 2, 'Matthew is added to Territory A', `${r.status} reps=${JSON.stringify(r.body.repIds)}`)
    const own = await owners(manager)
    ok(insideIds.every((id) => own[id] === curtis.id), 'every house Curtis was working is still his — nothing was overwritten')
    const [c, m, s] = await Promise.all([phone(curtis.token), phone(matthew.token), phone(sarah.token)])
    ok(c.leads.size === 4, 'Curtis still sees all four', `${c.leads.size}`)
    ok(m.leads.size === 4 && insideIds.every((id) => m.leads.has(id)), 'Matthew now sees the same four — the patch is shared', `${m.leads.size}`)
    ok(s.leads.size === 0, 'Sarah, not on it, sees none', `${s.leads.size}`)
    const b = await (await call('/api/bootstrap', {}, matthew.token)).json()
    const t = (b.territories ?? []).find((x) => x.id === T.id)
    ok(t?.repIds?.length === 2 && t.repIds.includes(curtis.id) && t.repIds.includes(matthew.id), 'the phone is told who shares the patch')
    ok(t?.repId === curtis.id, 'and rep_id still names the first rep, for older readers')
  }

  /* ===== 3. a shared house can be worked by either ========================= */
  {
    const r = await j(await call('/api/mutations', {
      method: 'POST',
      body: JSON.stringify({ mutations: [{ id: `m_${stamp}_1`, kind: 'property.update', at: Date.now(), payload: { id: insideIds[0], city: 'Round Rock' } }] }),
    }, matthew.token))
    const applied = (r.body.results ?? r.body.applied ?? []).find?.((x) => x.id === `m_${stamp}_1`)
    ok(r.status === 200 && (applied ? applied.status === 'applied' : true), 'Matthew may edit a house in the shared patch that Curtis is working', `${r.status} ${JSON.stringify(r.body).slice(0, 120)}`)
    const s = await j(await call('/api/mutations', {
      method: 'POST',
      body: JSON.stringify({ mutations: [{ id: `m_${stamp}_2`, kind: 'property.update', at: Date.now(), payload: { id: insideIds[0], city: 'Round Rock' } }] }),
    }, sarah.token))
    const refused = (s.body.results ?? s.body.applied ?? []).find?.((x) => x.id === `m_${stamp}_2`)
    ok(refused ? refused.status !== 'applied' : s.status !== 200, 'Sarah, off the patch, may not', `${s.status} ${JSON.stringify(refused ?? s.body).slice(0, 120)}`)
  }

  /* ===== 4. Curtis comes off; his houses stay his ========================== */
  {
    const r = await j(await call('/api/territories/assign', { method: 'POST', body: JSON.stringify({ territoryId: T.id, repId: curtis.id, action: 'remove' }) }, manager))
    ok(r.status === 200 && r.body.repIds?.length === 1 && r.body.repIds[0] === matthew.id, 'Curtis is taken off Territory A; Matthew remains', `${r.status} reps=${JSON.stringify(r.body.repIds)}`)
    const own = await owners(manager)
    ok(insideIds.every((id) => own[id] === curtis.id), 'the houses he was working keep him — two facts, not one')
    const [c, m] = await Promise.all([phone(curtis.token), phone(matthew.token)])
    ok(c.leads.size === 4, 'so Curtis still sees his four houses', `${c.leads.size}`)
    ok(m.leads.size === 4, 'and Matthew sees the patch', `${m.leads.size}`)
  }

  /* ===== 5. Curtis on two patches at once ================================== */
  {
    const B = BOX.map((p) => ({ lat: p.lat + 0.1, lng: p.lng }))
    const r = await j(await call('/api/territories', { method: 'POST', body: JSON.stringify({ name: 'Territory B', repIds: [curtis.id, matthew.id], boundary: B }) }, manager))
    ok(r.status === 201 && r.body.territory?.repIds?.length === 2, 'Territory B is drawn with both of them on it', `${r.status}`)
    const a = await j(await call('/api/territories/assign', { method: 'POST', body: JSON.stringify({ territoryId: T.id, repId: curtis.id }) }, manager))
    ok(a.status === 200 && a.body.repIds?.length === 2, 'and Curtis goes back on A — one rep, two territories', `${a.status}`)
    ok(n(await query(`SELECT COUNT(*) FROM territory_reps WHERE user_id='${curtis.id}'`)) === 2, 'the join table holds both of his patches')
  }

  /* ===== 6. clearing is explicit, and the only way houses come loose ======== */
  {
    const r = await j(await call('/api/territories/assign', { method: 'POST', body: JSON.stringify({ territoryId: T.id, repId: null }) }, manager))
    ok(r.status === 200 && r.body.repIds?.length === 0 && r.body.assigned === 4, 'choosing Unassigned empties the patch and releases its four houses', `${r.status} ${JSON.stringify(r.body)}`)
    const [c, m] = await Promise.all([phone(curtis.token), phone(matthew.token)])
    ok(c.leads.size === 0 && m.leads.size === 0, 'and now neither phone shows them', `${c.leads.size}/${m.leads.size}`)
  }

  /* ===== 7. delete cascades; the audit log knows ============================ */
  {
    const bId = (await query("SELECT id FROM territories WHERE name='Territory B'"))[0]?.id
    const before = n(await query(`SELECT COUNT(*) FROM territory_reps WHERE territory_id='${bId}'`))
    const d = await j(await call(`/api/territories/${bId}`, { method: 'DELETE' }, manager))
    ok(d.status === 200, 'the manager deletes Territory B')
    const after = n(await query(`SELECT COUNT(*) FROM territory_reps WHERE territory_id='${bId}'`))
    ok(before === 2 && after === 0, 'and its rep rows go with it', `${before} → ${after}`)
    const un = n(await query("SELECT COUNT(*) FROM audit_log WHERE action='territory.unassigned'"))
    ok(un >= 1, 'the audit log records who took a rep off a patch', `${un}`)
  }
} finally {
  await stop().catch(() => {})
}

if (fails.length) {
  console.log(`\n${fails.length} failed:`)
  fails.forEach((f) => console.log(`  - ${f}`))
  process.exit(1)
}
console.log('\n=== two reps share a patch, and neither loses a house ===')
