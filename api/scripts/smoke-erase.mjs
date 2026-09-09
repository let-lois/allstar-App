import { spawn } from 'node:child_process'
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

/**
 * Erasing a lead — against a real Worker, a real database and real object
 * storage.
 *
 * This is the only destructive action in the product and it has no undo, so the
 * assertions come in two halves that fail in opposite directions.
 *
 * **Did it actually go?** Not "the endpoint returned 200" — the contacts, the
 * notes, the visits, the photo rows and the file in R2, each checked directly.
 * The failure this guards against is a cascade that does not fire, leaving
 * orphaned personal data that *looks* erased. Nobody goes looking twice.
 *
 * **Does it stay gone?** A property's id is derived from its address, so the
 * next CSV containing that address, or the next GoHighLevel webhook for that
 * contact, would recreate the lead. An erasure undone by Tuesday's import is not
 * an erasure, and the person who undid it would have no idea.
 *
 * And the half that is neither: who may do it. A manager runs the day and can
 * already reassign, re-route and close a lead — none of which destroys anything.
 *
 * **What this cannot see, stated rather than implied.** The R2 delete is asserted
 * by intent — the response reports how many files it found and went after — not
 * by observing the object gone. Local R2 is Miniflare's own store and there is no
 * way to interrogate it from out here that would not be testing Miniflare.
 *
 * The copies on reps' phones are covered — the server's half of that is cases 9
 * to 11 below, and the device actually deleting them is `verify:erasure-reach`,
 * which needs a real browser and a real IndexedDB and so cannot live here.
 */

const here = dirname(fileURLToPath(import.meta.url))
const api = resolve(here, '..')
const PORT = Number(process.env.PORT || 8831)
const BASE = `http://127.0.0.1:${PORT}`
const SETUP_TOKEN = 'local-setup-token'
const STATE = resolve(api, '.wrangler/erase-state')

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
     '--var', 'SESSION_PEPPER:local-erase-pepper',
     '--var', 'INTEGRATION_KEY:local-erase-key-do-not-reuse'],
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
const n = (rows) => Number(rows[0] ? Object.values(rows[0])[0] : -1)

const stamp = Date.now()
const OWNER = { email: `er-owner-${stamp}@example.com`, password: 'correct-horse-battery-99' }
const q = (s) => String(s).replace(/'/g, "''")
const ADDRESS = '88 Thornmere Row'

try {
  rmSync(STATE, { recursive: true, force: true })
  const config = writeConfig('erase-smoke.toml')
  await start(config); await applySchema(config); await stop(); await start(config)

  await call('/setup', {
    method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ token: SETUP_TOKEN, clientName: 'Summit Exteriors', name: 'Owner', email: OWNER.email, password: OWNER.password }),
  })
  const login = await call('/api/auth/login', { method: 'POST', body: JSON.stringify(OWNER) })
  ok(login.ok, `the owner can sign in (${login.status})`)
  const { token: session, user } = await login.json()
  const clientId = user.clientId

  /* --- a lead with everything hanging off it ---------------------------- */
  //
  // Created through the real import endpoint, not inserted with an id of our
  // choosing. That detail is the whole test: a property's id is derived from the
  // client and the normalised address, and the tombstone blocks by id. An
  // invented id would be blocked in the tombstone and re-created under a
  // different id by the next import — which is exactly what the first version of
  // this file did, passing "it did not come back" while the import cheerfully
  // recreated the lead beside it.
  const seedRes = await call('/api/import/properties', {
    method: 'POST',
    body: JSON.stringify({
      rows: [{ ref: '1', address1: ADDRESS, city: 'Round Rock', state: 'TX', zip: '78664', lat: 30.5, lng: -97.6 }],
    }),
  }, session)
  const seeded = await seedRes.json()
  const P = seeded.ids?.[0]
  ok(!!P && seeded.created === 1, 'the lead is created the way production creates one', `${P}`)
  await query(`INSERT INTO contacts (id,property_id,name,phone,email,is_primary)
     VALUES ('ct_${stamp}','${P}','Wilhelmina Ackerbridge','512-555-0148','w@example.com',1)`)
  await query(`INSERT INTO notes (id,client_id,property_id,body,author_id,created_at)
     VALUES ('n_${stamp}','${q(clientId)}','${P}','Elderly, lives alone. Back door.','${q(user.id)}',${stamp})`)
  await query(`INSERT INTO visits (id,client_id,property_id,rep_id,started_at,ended_at,outcome,start_lat,start_lng)
     VALUES ('v_${stamp}','${q(clientId)}','${P}','${q(user.id)}',${stamp},${stamp},'not_interested',30.5,-97.6)`)
  await query(`INSERT INTO photos (id,client_id,property_id,category,r2_key,created_at)
     VALUES ('ph_${stamp}','${q(clientId)}','${P}','roof','photos/${q(clientId)}/${P}/ph_${stamp}.jpg',${stamp})`)
  await query(`INSERT INTO activity (id,client_id,property_id,rep_id,type,summary,at)
     VALUES ('ac_${stamp}','${q(clientId)}','${P}','${q(user.id)}','visit','${ADDRESS}',${stamp})`)

  const before = {
    contacts: n(await query(`SELECT COUNT(*) FROM contacts WHERE property_id='${P}'`)),
    notes: n(await query(`SELECT COUNT(*) FROM notes WHERE property_id='${P}'`)),
    visits: n(await query(`SELECT COUNT(*) FROM visits WHERE property_id='${P}'`)),
    photos: n(await query(`SELECT COUNT(*) FROM photos WHERE property_id='${P}'`)),
    activity: n(await query(`SELECT COUNT(*) FROM activity WHERE property_id='${P}'`)),
  }
  // Asserted before erasing, so "0 afterwards" cannot pass on data that was
  // never there — which is how a delete test quietly proves nothing.
  ok(
    Object.values(before).every((v) => v === 1),
    'the lead starts with a contact, a note, a visit, a photo and an activity row',
    JSON.stringify(before),
  )

  /* ===== 1. not everybody may erase ==================================== */
  {
    const anon = await call('/api/leads/erase', {
      method: 'DELETE', body: JSON.stringify({ propertyId: P, reason: 'testing' }),
    })
    ok(anon.status === 401, 'erasing without a session is refused', `${anon.status}`)

    /*
      The role check, against a real session rather than a unit call. The owner
      is demoted to manager for one request — a manager runs the day and can
      already reassign, re-route and close a lead, none of which destroys
      anything, so erasure is deliberately out of reach.
    */
    await query(`UPDATE users SET role='manager' WHERE id='${q(user.id)}'`)
    const asManager = await call('/api/leads/erase', {
      method: 'DELETE', body: JSON.stringify({ propertyId: P, reason: 'manager should not be able to' }),
    }, session)
    ok(asManager.status === 403, 'and a manager is refused', `${asManager.status}`)
    const survived = n(await query(`SELECT COUNT(*) FROM properties WHERE id='${P}'`))
    ok(survived === 1, 'with the lead still there', `${survived} properties`)
    await query(`UPDATE users SET role='client_admin' WHERE id='${q(user.id)}'`)
  }

  /* ===== 2. a reason is required ====================================== */
  {
    const res = await call('/api/leads/erase', {
      method: 'DELETE', body: JSON.stringify({ propertyId: P, reason: '' }),
    }, session)
    ok(res.status === 400, 'erasing without a reason is refused', `${res.status}`)
    const still = n(await query(`SELECT COUNT(*) FROM properties WHERE id='${P}'`))
    ok(still === 1, 'and the lead is untouched', `${still} properties`)
  }

  /* ===== 3. another tenant's lead is not erasable ===================== */
  {
    await query(`INSERT INTO clients (id,name,timezone,created_at) VALUES ('c_other_${stamp}','Rival','UTC',${stamp})`)
    const OTHER = `p_other_${stamp}`
    await query(`INSERT INTO properties (id,client_id,address1,lat,lng,status,score,updated_at)
       VALUES ('${OTHER}','c_other_${stamp}','1 Rival Rd',30.5,-97.6,'new',50,${stamp})`)
    const res = await call('/api/leads/erase', {
      method: 'DELETE', body: JSON.stringify({ propertyId: OTHER, reason: 'should not work' }),
    }, session)
    ok(res.status === 404, "another company's lead is refused, not erased", `${res.status}`)
    const survived = n(await query(`SELECT COUNT(*) FROM properties WHERE id='${OTHER}'`))
    ok(survived === 1, 'and their row is untouched', `${survived} still there`)

    /*
      Bulk status, tested here rather than in `smoke:import` because this is
      where a second tenant actually exists.

      The version of this in the import smoke passed an id that existed nowhere
      at all, which proves only that a missing row changes nothing — it passed
      just as happily with the tenant predicate removed. A real row under
      somebody else's client is the only fixture that can tell the difference,
      and there is one right here.
    */
    const bulk = await call('/api/leads/status', {
      method: 'POST',
      body: JSON.stringify({ propertyIds: [OTHER], status: 'won' }),
    }, session)
    const bulkBody = await bulk.json()
    ok(bulkBody.updated === 0, "and a bulk status change cannot reach it either", JSON.stringify(bulkBody))
    const theirStatus = (await query(`SELECT status FROM properties WHERE id='${OTHER}'`))[0]?.status
    ok(theirStatus === 'new', "with their lead still holding its own status", String(theirStatus))
    // No tombstone under our client either: an id that was never ours must not
    // end up on our block-list.
    const junk = n(await query(
      `SELECT COUNT(*) FROM deletions WHERE client_id='${q(clientId)}' AND entity_id='${OTHER}'`))
    ok(junk === 0, 'and nothing was written to our tombstones', `${junk}`)
  }

  /* ===== 4. it actually goes ========================================== */
  {
    const res = await call('/api/leads/erase', {
      method: 'DELETE',
      body: JSON.stringify({ propertyId: P, reason: 'Homeowner asked to be removed' }),
    }, session)
    const out = await res.json()
    ok(res.ok && out.ok, `the erase succeeds (${res.status})`, JSON.stringify(out))
    ok(out.photos === 1, 'and reports the photo it took with it', String(out.photos))

    const after = {
      property: n(await query(`SELECT COUNT(*) FROM properties WHERE id='${P}'`)),
      contacts: n(await query(`SELECT COUNT(*) FROM contacts WHERE property_id='${P}'`)),
      notes: n(await query(`SELECT COUNT(*) FROM notes WHERE property_id='${P}'`)),
      visits: n(await query(`SELECT COUNT(*) FROM visits WHERE property_id='${P}'`)),
      photos: n(await query(`SELECT COUNT(*) FROM photos WHERE property_id='${P}'`)),
      activity: n(await query(`SELECT COUNT(*) FROM activity WHERE property_id='${P}'`)),
    }
    ok(
      Object.values(after).every((v) => v === 0),
      'the property, contact, note, visit, photo row and activity are all gone',
      JSON.stringify(after),
    )
  }

  /* ===== 5. the act is recorded, and identifiable ===================== */
  {
    const rows = await query(
      `SELECT action, target_label, detail FROM audit_log WHERE client_id='${q(clientId)}' AND action='lead.erased'`)
    ok(rows.length === 1, 'the erasure is in the audit log', `${rows.length} entries`)
    ok(rows[0]?.target_label === ADDRESS, 'with the address it had', rows[0]?.target_label)
    ok(/Homeowner asked/.test(rows[0]?.detail ?? ''), 'and the reason that was given')
  }

  /* ===== 6. it stays gone: the CSV route ============================== */
  {
    /*
      Two rows: the erased address, and a fresh one.

      The fresh row is the control, and it is the reason this assertion means
      anything. The first version of this posted to `/api/import`, which does not
      exist — the request 404'd, nothing was imported, and "the lead did not come
      back" passed on an import that never ran. A test that proves a block by
      never reaching the thing it blocks is not a test.
    */
    const res = await call('/api/import/properties', {
      method: 'POST',
      body: JSON.stringify({
        rows: [
          { ref: '1', address1: ADDRESS, city: 'Round Rock', state: 'TX', zip: '78664', lat: 30.5, lng: -97.6 },
          { ref: '2', address1: '5 Freshfield Way', city: 'Round Rock', state: 'TX', zip: '78664', lat: 30.5, lng: -97.6 },
        ],
      }),
    }, session)
    const out = await res.json().catch(() => ({}))
    ok(res.ok, `the import ran (${res.status})`, JSON.stringify(out).slice(0, 100))

    const control = n(await query(
      `SELECT COUNT(*) FROM properties WHERE client_id='${q(clientId)}' AND address1='5 Freshfield Way'`))
    ok(control === 1, 'the control row in the same file was imported', `${control}`)

    const back = n(await query(`SELECT COUNT(*) FROM properties WHERE id='${P}'`))
    ok(back === 0, 'but the erased address did not come back', `${back} properties`)
    ok(
      /erased/i.test(JSON.stringify(out.rejected ?? [])),
      'and the operator is told why, rather than the row silently vanishing',
      JSON.stringify(out.rejected ?? []).slice(0, 110),
    )
  }

  /* ===== 7. erasing again confirms rather than errors ================= */
  {
    const res = await call('/api/leads/erase', {
      method: 'DELETE', body: JSON.stringify({ propertyId: P, reason: 'Homeowner asked to be removed' }),
    }, session)
    const out = await res.json()
    ok(res.ok && out.alreadyGone === true, 'erasing something already erased confirms it', JSON.stringify(out))
  }

  /* ===== 8. the tombstone keeps nothing it should not ================= */
  //
  // A table of erased people's details would defeat the erasure.
  {
    const rows = await query(`SELECT * FROM deletions WHERE client_id='${q(clientId)}'`)
    ok(rows.length === 1, 'one tombstone exists', `${rows.length}`)
    const blob = JSON.stringify(rows[0] ?? {})
    ok(!blob.includes(ADDRESS), 'and it does not hold the address', blob.slice(0, 90))
    ok(!/Wilhelmina|512-555-0148|w@example.com/.test(blob), 'nor the name, phone or email')
  }
  /* ===== 9. a phone cannot undo an erasure ============================ */
  //
  // The hole this closes: a rep adds a lead at the door, the office erases it
  // while the phone is in a dead zone, and the phone later syncs the queued
  // `property.status` create. That is an INSERT, and it would have put the
  // address straight back under the same derived id with nobody told. The CSV
  // and webhook routes were both guarded against exactly this; the sync route
  // was not.
  {
    const stale = {
      id: `m_undo_${stamp}`,
      kind: 'property.status',
      createdAt: stamp,
      payload: { id: P, created: true, address1: ADDRESS, city: 'Round Rock', state: 'TX', zip: '78664', lat: 30.5, lng: -97.6 },
    }
    const res = await call('/api/mutations', { method: 'POST', body: JSON.stringify({ mutations: [stale] }) }, session)
    const { results } = await res.json()
    ok(results?.[0]?.status === 'obsolete',
      "a queued create for an erased lead is discarded, not applied and not refused",
      JSON.stringify(results?.[0]))

    const back = n(await query(`SELECT COUNT(*) FROM properties WHERE id='${P}'`))
    ok(back === 0, 'and the erased address did not come back through sync', `${back} properties`)

    /*
      Discarded, not rejected — and that distinction is the whole point of the
      status. A rejection un-claims the mutation so the phone retries it, which
      would leave the rep with a row failing forever against a lead that no
      longer exists. The ledger keeping the claim is what proves it is settled.
    */
    const claimed = n(await query(
      `SELECT COUNT(*) FROM applied_mutations WHERE id='m_undo_${stamp}'`))
    ok(claimed === 1, 'and the phone will not be asked to send it again', `${claimed} ledger rows`)
  }

  /* ===== 10. and a control: work for a live lead still lands ========== */
  //
  // Without this, case 9 passes just as well on a server that discards every
  // mutation it is given.
  {
    const live = (await query(
      `SELECT id FROM properties WHERE client_id='${q(clientId)}' AND address1='5 Freshfield Way'`))[0]?.id
    const m = {
      id: `m_live_${stamp}`,
      kind: 'property.status',
      createdAt: stamp,
      payload: { id: live, status: 'working' },
    }
    const res = await call('/api/mutations', { method: 'POST', body: JSON.stringify({ mutations: [m] }) }, session)
    const { results } = await res.json()
    ok(results?.[0]?.status === 'applied', 'a mutation for a lead that still exists is applied', JSON.stringify(results?.[0]))
    const st = (await query(`SELECT status FROM properties WHERE id='${live}'`))[0]?.status
    ok(st === 'working', 'and it took effect', `status=${st}`)
  }

  /* ===== 11. bootstrap tells the phones what was erased =============== */
  //
  // The list is what reaches the devices. Without it a rep's notes and
  // photographs of the household stay in a pocket indefinitely: bootstrap never
  // returns visits, notes or photos, so nothing in a refresh can ever remove
  // one, and the phone has no way to infer a removal from an absence.
  {
    const res = await call('/api/bootstrap', {}, session)
    const boot = await res.json()
    ok(Array.isArray(boot.erased), 'bootstrap carries an erased list', typeof boot.erased)
    ok(boot.erased?.includes(P), 'with the erased lead named in it', JSON.stringify(boot.erased))

    // The control: a lead that is merely absent from this rep's scope must not
    // appear here. An erased list that names everything would have the phone
    // deleting a rep's own work on leads that were only reassigned.
    const live = (await query(
      `SELECT id FROM properties WHERE client_id='${q(clientId)}' AND address1='5 Freshfield Way'`))[0]?.id
    // `Array.isArray` first, deliberately: `undefined?.includes(x)` is undefined,
    // so the bare negation would pass on a server that sends no list at all —
    // the exact failure this case exists to catch.
    ok(Array.isArray(boot.erased) && !boot.erased.includes(live),
      'and a live lead is not in it', `${boot.erased?.length} erased`)
    ok(boot.erased?.length === 1, 'exactly the one erasure', `${boot.erased?.length}`)
  }
} finally {
  await stop().catch(() => {})
  rmSync(STATE, { recursive: true, force: true })
}

if (fails.length) {
  console.log(`\n${fails.length} failed:`)
  fails.forEach((f) => console.log(`  - ${f}`))
  process.exit(1)
}
console.log('\n=== an erased lead is gone, stays gone, and leaves a record of who did it ===')
