import { spawn } from 'node:child_process'
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

/**
 * Leads out as a spreadsheet — against a real Worker and a real D1.
 *
 * What a file has to get right that a screen does not: every lead exactly once
 * (a house on two lists is one row), a note with commas, quotes and a line
 * break surviving as one cell, the filters actually narrowing the rows, a
 * formula in a name opening as text, and the door being shut on a rep. Read
 * back with a real RFC 4180 parser rather than split on commas, because a
 * split-on-commas check would pass a file Excel cannot open.
 */

const here = dirname(fileURLToPath(import.meta.url))
const api = resolve(here, '..')
const PORT = Number(process.env.PORT || 8901)
const BASE = `http://127.0.0.1:${PORT}`
const SETUP_TOKEN = 'local-setup-token'
const STATE = resolve(api, '.wrangler/export-state')

const fails = []
const ok = (c, m, measured) => {
  console.log(`${c ? 'PASS' : 'FAIL'}  ${m}${measured ? `  (${measured})` : ''}`)
  if (!c) fails.push(m)
}

const { Agent, setGlobalDispatcher } = await import('undici')
setGlobalDispatcher(new Agent({}))

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
     '--var', 'SESSION_PEPPER:local-export-pepper',
     '--var', 'INTEGRATION_KEY:local-export-key-do-not-reuse'],
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
async function query(sql) {
  const { execFile } = await import('node:child_process')
  const { promisify } = await import('node:util')
  const run = promisify(execFile)
  const { stdout } = await run(resolve(api, 'node_modules/.bin/wrangler'),
    ['d1', 'execute', 'allstar-db', '--local', '--persist-to', STATE, '--json', '--command', sql],
    { cwd: api, maxBuffer: 8 * 1024 * 1024 })
  return JSON.parse(stdout.slice(stdout.indexOf('[')))[0]?.results ?? []
}
const q = (s) => String(s).replace(/'/g, "''")

/** RFC 4180, the real thing: quoted fields may hold commas, doubled quotes and line breaks. */
function parseCsv(text) {
  const rows = []
  let row = []
  let field = ''
  let quoted = false
  for (let i = 0; i < text.length; i++) {
    const ch = text[i]
    if (quoted) {
      if (ch === '"') {
        if (text[i + 1] === '"') { field += '"'; i++ } else quoted = false
      } else field += ch
      continue
    }
    if (ch === '"') quoted = true
    else if (ch === ',') { row.push(field); field = '' }
    else if (ch === '\r') { /* CRLF: wait for the \n */ }
    else if (ch === '\n') { row.push(field); rows.push(row); row = []; field = '' }
    else field += ch
  }
  if (field.length || row.length) { row.push(field); rows.push(row) }
  return rows
}

async function mintRep(adminToken, name, stamp) {
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

const stamp = Date.now()
const OWNER = { email: `export-owner-${stamp}@example.com`, password: 'correct-horse-battery-99' }

try {
  rmSync(STATE, { recursive: true, force: true })
  const config = writeConfig('export-smoke.toml')
  await start(config); await applySchema(config); await stop(); await start(config)

  await call('/setup', {
    method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ token: SETUP_TOKEN, clientName: 'Summit Exteriors', name: 'Owner', email: OWNER.email, password: OWNER.password }),
  })
  const login = await call('/api/auth/login', { method: 'POST', body: JSON.stringify(OWNER) })
  ok(login.ok, `the owner can sign in (${login.status})`)
  const { token: owner, user } = await login.json()
  const clientId = user.clientId

  /* --- three leads, a contact each, a note that fights the format ---------- */
  const seeded = await (await call('/api/import/properties', {
    method: 'POST',
    body: JSON.stringify({
      rows: [
        { ref: '1', address1: '12 Oak St', city: 'Round Rock', state: 'TX', zip: '78664', lat: 30.51, lng: -97.67 },
        { ref: '2', address1: '14 Oak St', city: 'Round Rock', state: 'TX', zip: '78664', lat: 30.511, lng: -97.671 },
        { ref: '3', address1: '9 Elm Ave, Unit "B"', city: 'Round Rock', state: 'TX', zip: '78664', lat: 30.52, lng: -97.68 },
      ],
    }),
  }, owner)).json()
  const [A, B, C] = seeded.ids ?? []
  ok(seeded.created === 3 && A && B && C, 'three leads are created the way production creates them', `${seeded.created}`)

  await query(`INSERT INTO contacts (id,property_id,name,phone,email,is_primary) VALUES
    ('ct_a','${q(A)}','Maria "Mo" Alvarez, Jr.','+1 512 555 0101','maria@example.com',1),
    ('ct_a2','${q(A)}','Second Person','','',0),
    ('ct_c','${q(C)}','=HYPERLINK("http://evil.test")','','',1)`)

  const NOTE = 'Roof looks 15+ yrs, said "come back Saturday", wants a quote\nGate left at 4:10pm'
  const mut = await (await call('/api/mutations', {
    method: 'POST',
    body: JSON.stringify({ mutations: [
      { id: `mut_note_${stamp}`, kind: 'note.create', payload: { id: `n_${stamp}`, propertyId: A, body: NOTE, tags: [] }, createdAt: Date.now() },
      // No comma and no quote — only a line break. The one shape a quoting rule
      // keyed on commas and quotes lets through, and it splits the row in two.
      { id: `mut_note2_${stamp}`, kind: 'note.create', payload: { id: `n2_${stamp}`, propertyId: B, body: 'Line one\nLine two', tags: [] }, createdAt: Date.now() },
    ] }),
  }, owner)).json()
  ok(mut.results?.[0]?.status === 'applied', 'the note is recorded through the real mutation path', mut.results?.[0]?.status)

  const bea = await mintRep(owner, 'Bea', stamp)
  const assigned = await (await call('/api/properties/assign', {
    method: 'POST', body: JSON.stringify({ propertyIds: [A], repId: bea.id }),
  }, owner)).json()
  ok(assigned.assigned === 1, 'one lead is handed to Bea', JSON.stringify(assigned))

  const LIST = 'Oak Street, "Area"'
  const made = await (await call('/api/lists', {
    method: 'POST', body: JSON.stringify({ name: LIST, propertyIds: [A, B], repIds: [bea.id] }),
  }, owner)).json()
  const listId = made.list?.id
  ok(!!listId && made.list.leadIds.length === 2, 'a list holds two of the three', `${made.list?.leadIds?.length}`)
  const second = await (await call('/api/lists', {
    method: 'POST', body: JSON.stringify({ name: 'Second Pass', propertyIds: [A] }),
  }, owner)).json()
  ok(second.list?.leadIds?.length === 1, 'and a second list holds the first lead again')

  /* --- everything ---------------------------------------------------------- */
  const all = await call('/api/leads/export.csv', {}, owner)
  ok(all.status === 200, `the export answers (${all.status})`)
  ok(/^text\/csv/.test(all.headers.get('content-type') ?? ''), 'as CSV', all.headers.get('content-type'))
  ok(/attachment; filename="allstar-leads-\d{4}-\d{2}-\d{2}\.csv"/.test(all.headers.get('content-disposition') ?? ''), 'named as a download', all.headers.get('content-disposition'))
  const text = await all.text()
  ok(text.includes('\r\n'), 'with CRLF line ends')
  const rows = parseCsv(text)
  const header = rows[0]
  const want = ['lead_id','address','city','state','zip','lat','lng','status','name','phone','email','assigned_rep','lists','score','opportunity_value','last_outcome','last_visit','next_action','notes','first_activity','updated']
  ok(JSON.stringify(header) === JSON.stringify(want), 'the header names every column, in order', header.join(','))
  const data = rows.slice(1)
  ok(data.length === 3, 'three leads, three rows — the lead on two lists is one row', `${data.length}`)
  ok(data.every((r) => r.length === header.length), 'every row has every column — the note with a line break did not split one')
  const ids = data.map((r) => r[0])
  ok(new Set(ids).size === ids.length, 'no lead appears twice')
  const col = (name) => header.indexOf(name)
  const rowA = data.find((r) => r[0] === A)
  const rowC = data.find((r) => r[0] === C)
  const rowB = data.find((r) => r[0] === B)
  ok((rowB?.[col('notes')] ?? '').endsWith('Line one\nLine two'), 'a note with only a line break is still one cell', JSON.stringify(rowB?.[col('notes')]))
  ok(rowA?.[col('name')] === 'Maria "Mo" Alvarez, Jr.', 'the primary contact, quotes and comma intact', rowA?.[col('name')])
  ok(rowA?.[col('phone')] === "'+1 512 555 0101" || rowA?.[col('phone')] === '+1 512 555 0101', 'the phone survives', rowA?.[col('phone')])
  ok(rowA?.[col('email')] === 'maria@example.com', 'and the email')
  ok(rowA?.[col('assigned_rep')] === 'Bea', 'the assigned rep by name', rowA?.[col('assigned_rep')])
  ok(rowA?.[col('lists')] === `${LIST}; Second Pass`, 'both lists, by name, in one cell', rowA?.[col('lists')])
  ok((rowA?.[col('notes')] ?? '').includes('come back Saturday') && (rowA?.[col('notes')] ?? '').includes('\nGate left at 4:10pm') && /Owner:/.test(rowA?.[col('notes')] ?? ''), 'the note is one cell with its line break, signed by its author', JSON.stringify(rowA?.[col('notes')]))
  ok(rowA?.[col('first_activity')] !== '' && !Number.isNaN(Date.parse(rowA?.[col('first_activity')] ?? '')), 'first activity is an ISO date once something happened', rowA?.[col('first_activity')])
  ok(!Number.isNaN(Date.parse(rowA?.[col('updated')] ?? '')), 'and updated is an ISO date')
  ok(rowC?.[col('address')] === '9 Elm Ave, Unit "B"', 'an address with a comma and quotes round-trips', rowC?.[col('address')])
  ok((rowC?.[col('name')] ?? '').startsWith("'="), 'a name that is a formula is disarmed with an apostrophe', rowC?.[col('name')])
  ok(rowC?.[col('lng')] === '-97.68', 'while a negative longitude is left as a number', rowC?.[col('lng')])
  ok(rowC?.[col('lists')] === '' && rowC?.[col('assigned_rep')] === '', 'a lead on no list, assigned to nobody, has empty cells rather than placeholders')

  /* --- narrowed ------------------------------------------------------------ */
  const byList = await call(`/api/leads/export.csv?list=${encodeURIComponent(listId)}`, {}, owner)
  const listRows = parseCsv(await byList.text()).slice(1)
  ok(listRows.length === 2 && listRows.every((r) => [A, B].includes(r[0])), 'filtering by list gives exactly its two houses', `${listRows.length}`)
  ok(/filename="allstar-oak-street-area-/.test(byList.headers.get('content-disposition') ?? ''), 'and the file is named after the list', byList.headers.get('content-disposition'))
  const byRep = parseCsv(await (await call(`/api/leads/export.csv?rep=${encodeURIComponent(bea.id)}`, {}, owner)).text()).slice(1)
  ok(byRep.length === 1 && byRep[0][0] === A, 'filtering by rep gives the one lead handed to Bea', `${byRep.length}`)
  const unassigned = parseCsv(await (await call('/api/leads/export.csv?rep=unassigned', {}, owner)).text()).slice(1)
  ok(unassigned.length === 2, 'and "unassigned" gives the other two', `${unassigned.length}`)
  const byStatus = parseCsv(await (await call('/api/leads/export.csv?status=won', {}, owner)).text()).slice(1)
  ok(byStatus.length === 0, 'a status nobody has yields a header and no rows')

  /* --- correcting details stops at the rep's own leads --------------------- */
  const tryFix = (token, id, name) => call('/api/mutations', {
    method: 'POST',
    body: JSON.stringify({ mutations: [{ id: `mut_fix_${id}_${stamp}`, kind: 'property.update', payload: { id, contacts: [{ id: `ct_fix_${id}`, name, isPrimary: true }] }, createdAt: Date.now() }] }),
  }, token).then((r) => r.json())
  const notHers = await tryFix(bea.token, C, 'Intruder')
  ok(notHers.results?.[0]?.status === 'rejected', 'a rep cannot edit a lead that is neither assigned to them nor on their list', notHers.results?.[0]?.status)
  const hers = await tryFix(bea.token, B, 'Via The List')
  ok(hers.results?.[0]?.status === 'applied', 'but can edit a house on a list handed to them', hers.results?.[0]?.error)
  const afterFix = parseCsv(await (await call(`/api/leads/export.csv?list=${encodeURIComponent(listId)}`, {}, owner)).text())
  const hdr = afterFix[0]
  const rowBfixed = afterFix.slice(1).find((r) => r[0] === B)
  ok(rowBfixed?.[hdr.indexOf('name')] === 'Via The List', 'and the office sees the corrected name in the very next export', rowBfixed?.[hdr.indexOf('name')])

  /* --- the door ------------------------------------------------------------ */
  const missing = await call('/api/leads/export.csv?list=ll_nope', {}, owner)
  ok(missing.status === 404, `an unknown list is a 404, not an empty file (${missing.status})`)
  const asRep = await call('/api/leads/export.csv', {}, bea.token)
  ok(asRep.status === 403, `a rep is refused (${asRep.status})`)
  const anon = await call('/api/leads/export.csv')
  ok(anon.status === 401, `nobody is refused (${anon.status})`)

  const audits = await query(`SELECT detail FROM audit_log WHERE client_id='${q(clientId)}' AND action='leads.exported'`)
  ok(audits.length === 6, 'every export that produced a file is in the audit log, none of the refusals', `${audits.length}`)
  ok(audits.some((a) => /"rows":3/.test(a.detail)) && audits.some((a) => /"rows":2/.test(a.detail) && a.detail.includes(listId)), 'with the row count and the list it was for')
} finally {
  await stop().catch(() => {})
  rmSync(STATE, { recursive: true, force: true })
}

if (fails.length) {
  console.log(`\n${fails.length} failed:`)
  fails.forEach((f) => console.log(`  - ${f}`))
  process.exit(1)
}
console.log('\n=== every lead once, every note intact, and the door shut on a rep ===')
