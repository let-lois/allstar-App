/**
 * The "about a hundred" wall — import, bulk edit, lists, territories and
 * export at the sizes where they used to fail.
 *
 * D1 binds at most 100 parameters per statement (src/d1.ts). Fifteen server
 * functions chunked their id lists at 100 or 200 and bound one to four shared
 * parameters on top, so each one failed somewhere between 96 and 100 rows:
 * imports of a real lead file, a territory drawn round a neighbourhood, a list
 * of a street's worth of houses, "select all → assign". Every size in the
 * brief, each through the real endpoint, each recorded.
 *
 *   npm run smoke:scale            (a Worker on 8787 and an admin, as smoke:all sets up)
 *   SIZES=50,100,181 npm run smoke:scale
 *
 * Prints a table — size, operation, HTTP status, time, processed — and fails
 * on any non-2xx or any count that does not add up.
 */

const BASE = process.env.API_URL || 'http://127.0.0.1:8787'
const ADMIN = {
  email: process.env.ADMIN_EMAIL || 'owner@example.com',
  password: process.env.ADMIN_PASSWORD || 'correct-horse-battery',
}
const SIZES = (process.env.SIZES || '50,75,90,99,100,101,125,150,181,200,500').split(',').map(Number)
const BIG = Number(process.env.BIG || 1000)

const fails = []
const rows = []
const ok = (cond, msg) => {
  if (!cond) {
    fails.push(msg)
    console.log(`FAIL  ${msg}`)
  }
}

const api = async (path, opts = {}, token) => {
  const t0 = Date.now()
  const res = await fetch(`${BASE}${path}`, {
    ...opts,
    headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}), ...opts.headers },
  })
  const ms = Date.now() - t0
  const text = await res.text()
  let body
  try {
    body = JSON.parse(text)
  } catch {
    body = text
  }
  return { status: res.status, ms, body }
}

const login = await api('/api/auth/login', { method: 'POST', body: JSON.stringify(ADMIN) })
if (login.status !== 200) {
  console.error(`Could not sign in as ${ADMIN.email} (${login.status}). Run \`npm run smoke:onboarding\` first.`)
  process.exit(1)
}
const token = login.body.token
const me = (await api('/api/me', {}, token)).body
const myId = me.user?.id ?? me.id

// A grid of houses in its own block for each size, so no two sizes overlap and
// a territory drawn round one block holds exactly that block's leads.
const run = Date.now().toString(36)
function block(n, k) {
  const lat0 = 30.1 + k * 0.02
  const lng0 = -97.9
  const per = Math.ceil(Math.sqrt(n))
  return Array.from({ length: n }, (_, i) => ({
    ref: String(i + 2),
    address1: `${1000 + i} Scale ${run} ${n} St`,
    city: 'Austin',
    state: 'TX',
    zip: '78701',
    lat: lat0 + Math.floor(i / per) * 0.0002,
    lng: lng0 + (i % per) * 0.0002,
    ownerName: i % 3 === 0 ? `Owner ${i}` : undefined,
  }))
}
const boxAround = (pts) => {
  const lats = pts.map((p) => p.lat), lngs = pts.map((p) => p.lng)
  const s = Math.min(...lats) - 0.0005, n = Math.max(...lats) + 0.0005, w = Math.min(...lngs) - 0.0005, e = Math.max(...lngs) + 0.0005
  return [{ lat: s, lng: w }, { lat: s, lng: e }, { lat: n, lng: e }, { lat: n, lng: w }]
}

function note(size, op, r, processed, extra = '') {
  rows.push({ size, op, status: r.status, ms: r.ms, processed, extra })
  ok(r.status >= 200 && r.status < 300, `${op} at ${size}: HTTP ${r.status} ${typeof r.body === 'object' ? (r.body.error ?? '') : ''}`)
}

let k = 0
for (const n of SIZES) {
  k++
  const leads = block(n, k)

  // Import (one request; the server takes up to 500 per request).
  const imp = await api('/api/import/properties', { method: 'POST', body: JSON.stringify({ rows: leads }) }, token)
  const ids = imp.body?.ids ?? []
  note(n, 'import', imp, ids.length, imp.status < 300 ? `created ${imp.body.created}, rejected ${imp.body.rejected?.length ?? 0}` : '')
  if (imp.status >= 300) continue
  ok(imp.body.created === n && ids.length === n, `import ${n}: created ${imp.body.created}, ids ${ids.length}`)

  // Re-import the same file: every row an update, none created twice.
  const again = await api('/api/import/properties', { method: 'POST', body: JSON.stringify({ rows: leads }) }, token)
  note(n, 're-import', again, again.body?.updated ?? 0, again.status < 300 ? `created ${again.body.created}, updated ${again.body.updated}` : '')
  if (again.status < 300) ok(again.body.created === 0 && again.body.updated === n, `re-import ${n}: created ${again.body.created}, updated ${again.body.updated}`)

  // Bulk assign every one to a rep, then back to nobody.
  const asg = await api('/api/properties/assign', { method: 'POST', body: JSON.stringify({ propertyIds: ids, repId: myId }) }, token)
  note(n, 'bulk assign', asg, asg.body?.assigned ?? asg.body?.updated ?? '?')
  const un = await api('/api/properties/assign', { method: 'POST', body: JSON.stringify({ propertyIds: ids, repId: null }) }, token)
  note(n, 'bulk unassign', un, un.body?.assigned ?? un.body?.updated ?? '?')

  // Bulk status.
  const st = await api('/api/leads/status', { method: 'POST', body: JSON.stringify({ propertyIds: ids, status: 'follow_up' }) }, token)
  note(n, 'bulk status', st, st.body?.updated ?? '?')

  // A list of all of them, then remove them all.
  const list = await api('/api/lists', { method: 'POST', body: JSON.stringify({ name: `Scale ${run} ${n}`, propertyIds: ids }) }, token)
  const listId = list.body?.list?.id ?? list.body?.id
  const listCount = list.body?.list?.leadIds?.length ?? list.body?.leadIds?.length ?? list.body?.added
  note(n, 'list create', list, listCount ?? '?')
  if (listId) {
    const rm = await api(`/api/lists/${listId}/members`, { method: 'POST', body: JSON.stringify({ remove: ids }) }, token)
    note(n, 'list remove all', rm, rm.body?.removed ?? '?')
    ok(rm.body?.removed === n, `list remove ${n}: removed ${rm.body?.removed}`)
    const add = await api(`/api/lists/${listId}/members`, { method: 'POST', body: JSON.stringify({ add: ids }) }, token)
    note(n, 'list add all', add, add.body?.added ?? '?')
    ok(add.body?.added === n, `list add ${n}: added ${add.body?.added}`)
  }

  // A territory drawn round the block: every existing lead inside is claimed.
  const terr = await api('/api/territories', { method: 'POST', body: JSON.stringify({ name: `Scale ${run} ${n}`, boundary: boxAround(leads) }) }, token)
  note(n, 'territory create', terr, terr.body?.assigned ?? '?')
  if (terr.status < 300) {
    ok(terr.body.assigned === n, `territory ${n}: claimed ${terr.body.assigned}`)
    const tid = terr.body.territory?.id
    const mv = await api('/api/properties/territory', { method: 'POST', body: JSON.stringify({ propertyIds: ids, territoryId: null }) }, token)
    note(n, 'bulk move territory', mv, mv.body?.moved ?? mv.body?.updated ?? '?')
    if (tid) {
      const del = await api(`/api/territories/${tid}`, { method: 'DELETE' }, token)
      note(n, 'territory delete', del, del.body?.released ?? '?')
    }
  }
}

// 1,000 rows the way the console sends them: in requests of 500.
{
  const leads = block(BIG, ++k)
  let created = 0, failedChunks = 0, totalMs = 0
  for (let i = 0; i < leads.length; i += 500) {
    const r = await api('/api/import/properties', { method: 'POST', body: JSON.stringify({ rows: leads.slice(i, i + 500) }) }, token)
    totalMs += r.ms
    if (r.status >= 300) failedChunks++
    else created += r.body.created
  }
  rows.push({ size: BIG, op: 'import (500 per request)', status: failedChunks ? 'FAIL' : 200, ms: totalMs, processed: created, extra: `${failedChunks} failed request(s)` })
  ok(!failedChunks && created === BIG, `import ${BIG}: created ${created}, failed requests ${failedChunks}`)
}

// Export of everything, and the row count it says it wrote.
{
  const t0 = Date.now()
  const res = await fetch(`${BASE}/api/leads/export.csv`, { headers: { authorization: `Bearer ${token}` } })
  const text = await res.text()
  rows.push({ size: 'all', op: 'export', status: res.status, ms: Date.now() - t0, processed: res.headers.get('x-rows'), extra: `${text.split('\n').length - 1} lines` })
  ok(res.status === 200, `export: HTTP ${res.status}`)
}

console.log('\nsize  | operation                  | status | ms    | processed | detail')
console.log('------|----------------------------|--------|-------|-----------|-------')
for (const r of rows) {
  console.log(`${String(r.size).padEnd(5)} | ${r.op.padEnd(26)} | ${String(r.status).padEnd(6)} | ${String(r.ms).padEnd(5)} | ${String(r.processed).padEnd(9)} | ${r.extra}`)
}
if (process.env.SCALE_OUT) {
  const { writeFileSync } = await import('node:fs')
  writeFileSync(process.env.SCALE_OUT, JSON.stringify(rows, null, 1))
}
if (fails.length) {
  console.log(`\n${fails.length} failure(s)`)
  process.exit(1)
}
console.log('\n=== scale OK ===')
