import { chromium } from 'playwright'
import { chromiumPath } from './lib/browser.mjs'

/**
 * An erasure reaches the copies on a rep's phone.
 *
 * The server side of this has worked since the deletion machinery landed: the
 * lead goes from the database, the photographs go from object storage, and a
 * tombstone stops the address coming back. None of it touched the devices, and
 * the devices are where a large share of the actual personal data sits — the
 * free text a rep typed about a household, and the photograph of their house,
 * held as bytes on the row in IndexedDB.
 *
 * ## Why this has to be a browser test
 *
 * The three stores that matter — visits, notes, photos — are the three bootstrap
 * never returns, precisely so a refresh cannot delete a rep's own work. That
 * makes them the stores no amount of server-side testing can speak for. The only
 * honest assertion is "open a real browser, put real rows in real IndexedDB, run
 * the real refresh, and read the stores back".
 *
 * ## The shape of a false pass, and the control against it
 *
 * A purge that deleted everything would satisfy every "it is gone" assertion in
 * here. So every deletion is paired with a **keeper**: a second lead, seeded
 * identically in every store, that must survive the same refresh untouched. Any
 * assertion below that reads "gone" has a twin that reads "still there", and
 * both have to hold in the same run.
 *
 * The before-counts are asserted too. "Nothing left for the erased lead" is
 * trivially true of a fixture that never wrote anything, which is the way a
 * deletion test most often ends up proving nothing at all.
 */

const BASE = process.env.BASE_URL || 'http://127.0.0.1:4173'

const fails = []
const ok = (cond, msg, measured) => {
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${msg}${measured ? `  (${measured})` : ''}`)
  if (!cond) fails.push(msg)
}

const DOOMED = 'p_doomed_erasure_test'
const KEEPER = 'p_keeper_erasure_test'

/*
  A distinct, greppable string in each lead's note.

  Two of them rather than one, and that is not decoration. The first version of
  this file wrote the same string into both notes and then searched the whole
  database for it afterwards — which found the *keeper's* note and reported a
  leak that was not there. A single marker cannot tell "the erased household's
  note survived" apart from "some household's note survived", which is the only
  question this assertion exists to answer.
*/
const DOOMED_SECRET = 'Wilhelmina-Ackerbridge-hunter2-zx9'
const KEEPER_SECRET = 'Bartholomew-Quillfeather-swordfish-qq4'

const browser = await chromium.launch({ executablePath: chromiumPath() })
const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true })
const page = await ctx.newPage()
const errors = []
page.on('pageerror', (e) => errors.push(String(e)))

/** Read every store back, counted by which lead each row belongs to. */
const readBack = () =>
  page.evaluate(
    ({ DOOMED, KEEPER }) =>
      new Promise((res, rej) => {
        const req = indexedDB.open('allstar-field')
        req.onerror = () => rej(new Error('no db'))
        req.onsuccess = () => {
          const d = req.result
          const stores = ['properties', 'visits', 'notes', 'photos', 'appointments', 'tasks', 'activity', 'routes', 'outbox']
          const tx = d.transaction(stores, 'readonly')
          const out = {}
          let left = stores.length
          for (const s of stores) {
            const r = tx.objectStore(s).getAll()
            r.onsuccess = () => {
              out[s] = r.result
              if (--left === 0) {
                const target = (row) => {
                  if (row.propertyId) return row.propertyId
                  if (row.id === DOOMED || row.id === KEEPER) return row.id
                  const p = row.payload || {}
                  return p.propertyId || p.id || null
                }
                const count = (which) => {
                  const c = {}
                  for (const s of stores) {
                    if (s === 'routes') continue
                    c[s] = out[s].filter((row) => target(row) === which).length
                  }
                  // Route stops are inline, so they are counted rather than the
                  // route itself — deleting the route would take the rest of a
                  // rep's day with it.
                  c.routeStops = out.routes
                    .flatMap((r) => r.stops ?? [])
                    .filter((st) => st.propertyId === which).length
                  return c
                }
                res({
                  doomed: count(DOOMED),
                  keeper: count(KEEPER),
                  routes: out.routes.length,
                  raw: JSON.stringify(out),
                })
              }
            }
            r.onerror = () => rej(new Error(`read ${s} failed`))
          }
        }
      }),
    { DOOMED, KEEPER },
  )

try {
  // The app itself creates the database at the right version. Seeding into a
  // schema this file invented would test a database the app does not use.
  await page.goto(BASE, { waitUntil: 'domcontentloaded' })
  await page.waitForTimeout(2500)

  /* ---- seed: two identical leads, one of which is about to be erased ---- */
  await page.evaluate(
    ({ DOOMED, KEEPER, DOOMED_SECRET, KEEPER_SECRET }) =>
      new Promise((res, rej) => {
        const req = indexedDB.open('allstar-field')
        req.onerror = () => rej(new Error('no db'))
        req.onsuccess = () => {
          const d = req.result
          const stores = ['properties', 'visits', 'notes', 'photos', 'appointments', 'tasks', 'activity', 'routes', 'outbox', 'meta']
          const tx = d.transaction(stores, 'readwrite')
          const now = Date.now()

          for (const id of [DOOMED, KEEPER]) {
            const tag = id === DOOMED ? 'doomed' : 'keeper'
            const secret = id === DOOMED ? DOOMED_SECRET : KEEPER_SECRET
            tx.objectStore('properties').put({
              id, address1: `${tag} 41 Marbury Lane`, city: 'Round Rock', state: 'TX', zip: '78664',
              lat: 30.5, lng: -97.6, status: 'working', score: 50, contacts: [],
            })
            tx.objectStore('visits').put({
              id: `v_${tag}`, propertyId: id, repId: 'u_1', startedAt: now, endedAt: now,
              outcome: 'interested', photoIds: [`ph_${tag}`],
              startLocation: { lat: 30.5, lng: -97.6, accuracy: 8 },
            })
            tx.objectStore('notes').put({
              id: `n_${tag}`, propertyId: id, body: `${secret} — elderly, lives alone, back door`,
              tags: [], authorId: 'u_1', createdAt: now,
            })
            // dataUrl is the picture itself. There is no second place holding
            // the bytes, so this row *is* the photograph.
            tx.objectStore('photos').put({
              id: `ph_${tag}`, propertyId: id, category: 'roof',
              dataUrl: 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
              width: 1, height: 1, bytes: 68, takenAt: now,
            })
            tx.objectStore('appointments').put({
              id: `ap_${tag}`, propertyId: id, repId: 'u_1', startsAt: now + 86400000,
              durationMin: 30, title: 'Roof inspection',
            })
            tx.objectStore('tasks').put({
              id: `t_${tag}`, repId: 'u_1', propertyId: id, title: 'Call back',
              dueAt: now + 3600000, done: false, kind: 'call',
            })
            tx.objectStore('activity').put({
              id: `ac_${tag}`, propertyId: id, repId: 'u_1', type: 'note',
              summary: `${tag} note added`, at: now,
            })
            tx.objectStore('outbox').put({
              id: `ob_${tag}`, kind: 'note.create', createdAt: now, attempts: 0, status: 'queued',
              payload: { id: `n2_${tag}`, propertyId: id, body: `${secret} queued` },
            })
          }

          // One route holding both leads as stops. If the purge deletes the
          // route rather than editing the stop out, the keeper's stop vanishes
          // with it and the assertion below catches that.
          tx.objectStore('routes').put({
            id: 'r_test', repId: 'u_1', date: '2026-09-01', name: 'Test route',
            stops: [
              { propertyId: DOOMED, order: 1, status: 'pending' },
              { propertyId: KEEPER, order: 2, status: 'pending' },
            ],
          })

          // A live session, so the app refreshes from the server on boot rather
          // than sitting in the demo.
          tx.objectStore('meta').put({
            mode: 'live', token: 'test-session-token',
            user: { id: 'u_1', name: 'Test Rep', email: 'rep@example.com', role: 'field_rep', clientId: 'c_1' },
          }, 'allstar.session.v2')

          tx.oncomplete = () => res(true)
          tx.onerror = () => rej(new Error('seed failed'))
        }
      }),
    { DOOMED, KEEPER, DOOMED_SECRET, KEEPER_SECRET },
  )

  /* ---- the fixture is real ---------------------------------------------- */
  const before = await readBack()
  const seeded = (c) => Object.values(c).every((v) => v === 1)
  ok(seeded(before.doomed),
    'the lead about to be erased starts with a row in every store',
    JSON.stringify(before.doomed))
  ok(seeded(before.keeper),
    'and so does the lead that must survive',
    JSON.stringify(before.keeper))
  ok(before.raw.includes(DOOMED_SECRET) && before.raw.includes(KEEPER_SECRET),
    'both notes are really on the device', `${before.raw.length} bytes stored`)

  /* ---- the refresh, with the erasure in it ------------------------------ */
  //
  // Intercepted rather than simulated: this is the app's own bootstrap handler,
  // its own hydrate, and its own IndexedDB writes. Only the response is ours.
  await page.route('**/api/bootstrap*', (route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        user: { id: 'u_1', name: 'Test Rep', email: 'rep@example.com', role: 'field_rep', clientId: 'c_1' },
        // The keeper is still the server's; the erased lead simply is not here.
        properties: [{
          id: KEEPER, address1: 'keeper 41 Marbury Lane', city: 'Round Rock', state: 'TX',
          zip: '78664', lat: 30.5, lng: -97.6, status: 'working', score: 50, contacts: [],
        }],
        routes: [], appointments: [], tasks: [], activity: [], dailyStats: [], territories: [],
        erased: [DOOMED],
      }),
    }),
  )
  // Everything else the app asks for on boot. Left to fail and the failures are
  // asserted on below — a purge that only works when the network is perfect is
  // not a purge.
  await page.route('**/api/users*', (route) => route.fulfill({ status: 403, body: '{}' }))

  await page.reload({ waitUntil: 'domcontentloaded' })
  await page.waitForTimeout(3500)

  const after = await readBack()

  /* ---- gone ------------------------------------------------------------- */
  ok(after.doomed.properties === 0, 'the erased lead is gone from the device', `${after.doomed.properties}`)
  ok(after.doomed.visits === 0, 'its visits are gone', `${after.doomed.visits}`)
  ok(after.doomed.notes === 0, 'the notes a rep typed about the household are gone', `${after.doomed.notes}`)
  ok(after.doomed.photos === 0, 'the photograph of the house is gone', `${after.doomed.photos}`)
  ok(after.doomed.appointments === 0, 'its appointment is gone', `${after.doomed.appointments}`)
  ok(after.doomed.tasks === 0, 'its task is gone', `${after.doomed.tasks}`)
  ok(after.doomed.activity === 0, 'its activity is gone', `${after.doomed.activity}`)
  ok(after.doomed.routeStops === 0, 'and it is off the route', `${after.doomed.routeStops}`)
  ok(after.doomed.outbox === 0,
    'queued work about it is dropped, not left to retry against a lead that is gone',
    `${after.doomed.outbox}`)

  // The bytes, not the row count. A photo row deleted while its picture lived
  // somewhere else would pass every count above and still leave the photograph
  // on the phone — so the whole database is searched for the text.
  ok(!after.raw.includes(DOOMED_SECRET),
    "and nothing anywhere on the device still holds the erased household's note")
  // The control on that search: the same sweep, over the same database, must
  // still find the other household. Without it, "the string is not there" would
  // pass just as well on a database that had been wiped.
  ok(after.raw.includes(KEEPER_SECRET),
    "while the other household's note is still findable in the same sweep")

  /* ---- and the control survives ---------------------------------------- */
  ok(after.keeper.properties === 1, 'the other lead is still there', `${after.keeper.properties}`)
  ok(after.keeper.visits === 1, 'with its visits', `${after.keeper.visits}`)
  ok(after.keeper.notes === 1, 'its notes', `${after.keeper.notes}`)
  ok(after.keeper.photos === 1, 'its photograph', `${after.keeper.photos}`)
  ok(after.keeper.appointments === 1, 'its appointment', `${after.keeper.appointments}`)
  ok(after.keeper.tasks === 1, 'its task', `${after.keeper.tasks}`)
  ok(after.keeper.activity === 1, 'its activity', `${after.keeper.activity}`)
  ok(after.keeper.routeStops === 1, 'and its place on the route', `${after.keeper.routeStops}`)
  ok(after.keeper.outbox === 1, "and this rep's queued work about it is untouched", `${after.keeper.outbox}`)
  ok(after.routes === 1, 'the route itself survived rather than being deleted whole', `${after.routes} routes`)

  ok(errors.length === 0, 'and the app threw nothing doing it', errors.slice(0, 2).join(' | '))
} finally {
  await browser.close()
}

console.log('')
if (fails.length) {
  console.log(`${fails.length} check(s) failed:`)
  fails.forEach((f) => console.log(`  - ${f}`))
  process.exit(1)
}
console.log('=== an erasure reaches the copies on the phone ===')
