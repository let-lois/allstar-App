import { chromium } from 'playwright'
import { chromiumPath } from './lib/browser.mjs'
import { dismissTour } from './lib/tour.mjs'

/**
 * The field fixes, each held to the behaviour that was reported broken.
 *
 *   Photos. A photo added to a lead reaches the server with everything about
 *   it (the visit it was taken on, its size, when), shows in the lead's
 *   Activity, is in Edit details, survives saving the details, leaving the
 *   lead and a relaunch — and is only called "uploaded" once the server said
 *   it stored it.
 *
 *   Call, Text and Email. Inside the phone app they go through the shell's
 *   direct hand-off with the lead's own number and address; a failure says so;
 *   a lead with no number or email says that instead of offering a dead button;
 *   and the tap is its own.
 *
 *   The tutorial. Once finished it stays finished — through a visit, a note, a
 *   status change, leaving and coming back, a relaunch, a sign-out — and a
 *   replay from More does not make it come back after every visit. It is kept
 *   per person and role: somebody else on the same phone gets their own.
 */

const BASE = process.env.BASE_URL || 'http://127.0.0.1:4173'
const browser = await chromium.launch({ executablePath: chromiumPath() })
const fails = []
const ok = (cond, msg, measured) => {
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${msg}${measured !== undefined ? `  (${measured})` : ''}`)
  if (!cond) fails.push(msg)
}
const errors = []

const JPEG = Buffer.from(
  '/9j/4AAQSkZJRgABAQEAYABgAAD/2wBDAAgGBgcGBQgHBwcJCQgKDBQNDAsLDBkSEw8UHRofHh0a' +
    'HBwgJC4nICIsIxwcKDcpLDAxNDQ0Hyc5PTgyPC4zNDL/wAALCAACAAIBAREA/8QAHwAAAQUBAQEB' +
    'AQEAAAAAAAAAAAECAwQFBgcICQoL/8QAtRAAAgEDAwIEAwUFBAQAAAF9AQIDAAQRBRIhMUEGE1Fh' +
    'ByJxFDKBkaEII0KxwRVS0fAkM2JyggkKFhcYGRolJicoKSo0NTY3ODk6Q0RFRkdISUpTVFVWV1hZ' +
    'WmNkZWZnaGlqc3R1dnd4eXqDhIWGh4iJipKTlJWWl5iZmqKjpKWmp6ipqrKztLW2t7i5usLDxMXG' +
    'x8jJytLT1NXW19jZ2uHi4+Tl5ufo6erx8vP09fb3+Pn6/9oACAEBAAA/APn+v//Z',
  'base64',
)
const json = (status, body) => (route) => route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) })

const REP = { id: 'u_rep', clientId: 'c_live', clientName: 'Ridgeline Roofing', email: 'rep@ridgeline.test', name: 'Marcus Vance', role: 'field_rep' }
const base = { city: 'Round Rock', state: 'TX', zip: '78664', status: 'new', score: 60, assignedRepId: REP.id }
const WITH = { ...base, id: 'p_with', address1: '118 Cedar Bend Dr', lat: 30.5115, lng: -97.6755, contacts: [{ id: 'c1', name: 'Sam Brooks', phone: '(512) 555-0920', email: 'sam@example.com', isPrimary: true }] }
const WITHOUT = { ...base, id: 'p_without', address1: '120 Cedar Bend Dr', lat: 30.5117, lng: -97.6757, contacts: [] }

/** A live account against a mock server that records every mutation and upload. */
async function live({ shell = null, upload = json(200, { ok: true, key: 'k' }) } = {}) {
  const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, serviceWorkers: 'block' })
  if (shell) {
    // What the phone app installs: the shell's direct hand-off. `ok` decides
    // whether the phone "managed" to open it.
    await ctx.addInitScript((okDefault) => {
      window.__opened = []
      window.__openOk = okDefault
      window.__allstarShell = { openExternal: async (url) => { window.__opened.push(url); return { ok: window.__openOk } } }
    }, shell.ok)
  }
  const page = await ctx.newPage()
  page.on('pageerror', (e) => errors.push(String(e)))
  const mutations = []
  const uploads = []
  await page.route('**://maps.googleapis.com/**', (r) => r.abort())
  await page.route('**/api/auth/login', json(200, { token: 'tok', user: REP }))
  await page.route('**/api/bootstrap', json(200, { user: REP, properties: [WITH, WITHOUT], routes: [], appointments: [], tasks: [], activity: [], dailyStats: [], serverTime: Date.now() }))
  await page.route('**/api/mutations', async (route) => {
    const body = JSON.parse(route.request().postData() || '{}')
    mutations.push(...(body.mutations ?? []))
    await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ results: (body.mutations ?? []).map((m) => ({ id: m.id, status: 'applied' })), serverTime: Date.now() }) })
  })
  await page.route('**/api/properties/*/photos', json(200, { photos: [] }))
  await page.route('**/api/photos/**', async (route) => {
    if (route.request().method() === 'GET') return route.fulfill({ status: 200, contentType: 'image/jpeg', body: JPEG })
    uploads.push((route.request().postDataBuffer() ?? Buffer.alloc(0)).byteLength)
    await upload(route)
  })
  await page.goto(BASE, { waitUntil: 'networkidle' })
  await page.locator('input[type="email"]').fill(REP.email)
  await page.locator('input[autocomplete="current-password"]').fill('a-real-password')
  await page.getByRole('button', { name: /^Sign in$/ }).click()
  await page.waitForTimeout(1600)
  await dismissTour(page)
  return { ctx, page, mutations, uploads }
}
const open = async (page, path) => {
  await page.goto(`${BASE}${path}`, { waitUntil: 'domcontentloaded' })
  await page.waitForTimeout(1000)
  await dismissTour(page, 1500)
}
const expand = async (page, name) => {
  const b = page.getByRole('button', { name: new RegExp(`^${name}`) }).first()
  if ((await b.getAttribute('aria-expanded')) === 'false') await b.click()
  await page.waitForTimeout(300)
}
const idb = (page, store) =>
  page.evaluate((store) => new Promise((res) => {
    const q = indexedDB.open('allstar-field')
    q.onsuccess = () => { const r = q.result.transaction(store).objectStore(store).getAll(); r.onsuccess = () => res(r.result) }
  }), store)

try {
  /* ===== photos: add → upload → activity → reopen → Edit details → relaunch ===== */
  {
    let release
    const gate = new Promise((r) => (release = r))
    // The server holds the first upload until the test has looked at the
    // screen, so "uploaded" can be caught being claimed too early.
    const { ctx, page, mutations, uploads } = await live({
      upload: async (route) => { await gate; await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ ok: true, key: 'k' }) }) },
    })
    await open(page, `/property/${WITH.id}`)
    await expand(page, 'Photos')
    const chooser = page.waitForEvent('filechooser')
    await page.getByRole('button', { name: 'Take photo' }).first().click()
    await (await chooser).setFiles({ name: 'roof.jpg', mimeType: 'image/jpeg', buffer: JPEG })
    await page.waitForTimeout(1200)
    await page.getByRole('button', { name: /Roof/i }).first().click()
    await page.waitForTimeout(2500)

    const tallyBefore = await page.getByTestId('photo-tally').first().getAttribute('data-state').catch(() => null)
    ok(tallyBefore !== 'uploaded', 'while the server has not confirmed it, the photo is not called uploaded', tallyBefore)
    release()
    await page.waitForTimeout(3500)
    ok(uploads.length >= 1 && uploads[0] > 100, 'the bytes are uploaded', `${uploads.length} upload(s), ${uploads[0]} bytes`)
    ok(uploads.length === 1, 'exactly once — no duplicate upload', `${uploads.length}`)
    ok((await page.getByTestId('photo-tally').first().getAttribute('data-state')) === 'uploaded', 'and called uploaded once the server said it stored it')

    const create = mutations.find((m) => m.kind === 'photo.create')
    const p = create?.payload ?? {}
    ok(!!create && p.propertyId === WITH.id && p.width > 0 && p.height > 0 && p.createdAt > 0 && 'visitId' in p && 'capturedAt' in p, 'the photo reaches the server with all of its metadata — size, time, visit, place', JSON.stringify(Object.keys(p)))
    ok(/Roof/.test(p.label ?? ''), 'and the label its history line is written with', p.label)
    const rows = await idb(page, 'photos')
    ok(rows.length === 1 && /^data:image\//.test(rows[0].dataUrl ?? '') && !/^blob:|^file:/.test(rows[0].dataUrl ?? ''), 'the phone keeps the bytes themselves, not a temporary picker URI', (rows[0]?.dataUrl ?? '').slice(0, 22))

    await expand(page, 'Activity')
    ok(/Photo added · Roof/.test(await page.locator('body').innerText()), 'the photo shows in the lead’s Activity')

    // Leave, come back.
    await open(page, '/leads')
    await open(page, `/property/${WITH.id}`)
    await expand(page, 'Photos')
    ok((await page.getByRole('button', { name: /of property/ }).count()) >= 1, 'reopening the lead, the photo is there')

    // Edit details: the same photo, and still there after Save.
    await page.getByRole('button', { name: 'Edit details' }).first().click()
    await page.waitForTimeout(700)
    const inEdit = () => page.getByTestId('lead-edit-photos').getByRole('button', { name: /of property/ }).count()
    ok((await inEdit()) === 1, 'Edit details shows the same photo')
    await page.getByTestId('lead-edit-save').click()
    await page.waitForTimeout(1200)
    await page.getByRole('button', { name: 'Edit details' }).first().click()
    await page.waitForTimeout(700)
    ok((await inEdit()) === 1, 'and still does after saving the details and opening them again')
    await page.keyboard.press('Escape')

    // A relaunch: the page reloaded from nothing but what the phone kept.
    await page.reload({ waitUntil: 'domcontentloaded' })
    await page.waitForTimeout(1800)
    await open(page, `/property/${WITH.id}`)
    await expand(page, 'Photos')
    ok((await page.getByRole('button', { name: /of property/ }).count()) >= 1, 'after a relaunch the photo is on the lead')
    await page.getByRole('button', { name: 'Edit details' }).first().click()
    await page.waitForTimeout(700)
    ok((await inEdit()) === 1, 'and in Edit details')
    ok(uploads.length === 1, 'and nothing was uploaded twice', `${uploads.length}`)
    await ctx.close()
  }

  /* ===== photos: a failed upload says so, plainly, and offers to try again ===== */
  {
    const { ctx, page } = await live({ upload: json(500, { error: 'boom' }) })
    await open(page, `/property/${WITH.id}`)
    // Straight to the failed state: attempts spent, as after the retries run out.
    await expand(page, 'Photos')
    const chooser = page.waitForEvent('filechooser')
    await page.getByRole('button', { name: 'Take photo' }).first().click()
    await (await chooser).setFiles({ name: 'roof.jpg', mimeType: 'image/jpeg', buffer: JPEG })
    await page.waitForTimeout(1200)
    await page.getByRole('button', { name: /Roof/i }).first().click()
    await page.waitForTimeout(2500)
    await page.evaluate(() => new Promise((res) => {
      const q = indexedDB.open('allstar-field')
      q.onsuccess = () => {
        const s = q.result.transaction('photos', 'readwrite').objectStore('photos')
        const r = s.getAll()
        r.onsuccess = () => { for (const p of r.result) s.put({ ...p, attempts: 99, lastError: 'HTTP 500 boom' }); res() }
      }
    }))
    await page.reload({ waitUntil: 'domcontentloaded' })
    await page.waitForTimeout(1500)
    await open(page, `/property/${WITH.id}`)
    await expand(page, 'Photos')
    const failed = page.getByTestId('photo-upload-failed')
    const text = (await failed.innerText().catch(() => '')).trim()
    ok(/We couldn’t upload this photo\. Please try again\./.test(text), 'a failed upload says so in plain words', text)
    ok(!/500|boom|HTTP/.test(text), 'with no server error shown to the rep')
    ok((await failed.getByRole('button', { name: 'Try again' }).count()) === 1, 'and a Try again button right there')
    await ctx.close()
  }

  /* ===== Call, Text, Email through the shell's hand-off ======================= */
  {
    const { ctx, page, mutations } = await live({ shell: { ok: true } })
    await open(page, `/property/${WITH.id}`)
    const before = page.url()
    for (const [id, want] of [['comm-call', /^tel:5125550920$/], ['comm-text', /^sms:5125550920\?body=Hi%20Sam/], ['comm-email', /^mailto:sam@example\.com\?subject=/]]) {
      await page.getByTestId(id).click()
      await page.waitForTimeout(300)
      const opened = await page.evaluate(() => window.__opened.at(-1))
      ok(want.test(opened ?? ''), `${id.slice(5)} hands the lead’s own ${id === 'comm-email' ? 'address' : 'number'} to the phone`, opened)
    }
    ok(page.url() === before && (await page.locator('[role="dialog"]').count()) === 0, 'and nothing underneath the buttons reacts to the taps')
    await page.waitForTimeout(1500)
    const logged = mutations.filter((m) => m.kind === 'comm.log').map((m) => m.payload.kind)
    ok(logged.join(',') === 'call,sms,email', 'each is logged once the phone opened it', logged.join(','))

    // The phone could not open it.
    await page.evaluate(() => (window.__openOk = false))
    await page.getByTestId('comm-call').click()
    await page.waitForTimeout(400)
    ok((await page.getByTestId('comm-message').innerText().catch(() => '')).includes('We couldn’t open this action on your device.'), 'when the phone cannot open it, the rep is told')

    // No number, no email.
    await open(page, `/property/${WITHOUT.id}`)
    const n = await page.evaluate(() => window.__opened.length)
    await page.getByTestId('comm-call').click()
    await page.waitForTimeout(300)
    ok((await page.getByTestId('comm-message').innerText()) === 'No phone number available for this lead.', 'Call on a lead with no number says so')
    await page.getByTestId('comm-text').click()
    await page.waitForTimeout(300)
    ok((await page.getByTestId('comm-message').innerText()) === 'No phone number available for this lead.', 'and so does Text')
    await page.getByTestId('comm-email').click()
    await page.waitForTimeout(300)
    ok((await page.getByTestId('comm-message').innerText()) === 'No email address available for this lead.', 'Email with no address says so')
    ok((await page.evaluate(() => window.__opened.length)) === n, 'and nothing was handed to the phone')
    await ctx.close()
  }
  {
    // A browser, with no shell: plain links the browser follows.
    const { ctx, page } = await live()
    await open(page, `/property/${WITH.id}`)
    ok((await page.getByTestId('comm-call').getAttribute('href')) === 'tel:5125550920', 'in a browser Call is a plain tel: link to the lead’s number')
    ok(/^sms:5125550920/.test(await page.getByTestId('comm-text').getAttribute('href')) && /^mailto:sam@example\.com/.test(await page.getByTestId('comm-email').getAttribute('href')), 'and Text and Email are sms: and mailto: links')
    await ctx.close()
  }

  /* ===== the tutorial stays finished ========================================== */
  {
    const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, serviceWorkers: 'block' })
    const page = await ctx.newPage()
    page.on('pageerror', (e) => errors.push(String(e)))
    await page.route('**://maps.googleapis.com/**', (r) => r.abort())
    const tour = page.locator('[data-tour-card]')
    const shows = async (ms = 1600) => { await page.waitForTimeout(ms); return tour.isVisible().catch(() => false) }
    const demo = async (who) => {
      await page.goto(BASE, { waitUntil: 'domcontentloaded' })
      await page.waitForTimeout(900)
      await page.getByRole('button', { name: /Try the demo/ }).click()
      await page.getByRole('button', { name: who }).click()
    }

    await demo(/Dana Whitfield/)
    ok(await tour.first().waitFor({ state: 'visible', timeout: 4000 }).then(() => true).catch(() => false), 'first launch: the tutorial appears')
    await page.locator('[data-tour-skip]').click()
    await page.waitForTimeout(400)

    // Work: a visit (which takes the whole screen and brings the shell back),
    // a note, a status change.
    const leadId = (await idb(page, 'properties'))[0].id
    /*
      Navigation inside the app, the way a rep moves around it — never a page
      load. A reload rebuilds the store, and the store's leftover tour request
      was the bug: a test that reloads between steps cannot see it.
    */
    const go = async (path) => {
      await page.evaluate((path) => {
        window.history.pushState({}, '', path)
        window.dispatchEvent(new PopStateEvent('popstate'))
      }, path)
      await page.waitForTimeout(900)
    }
    // A whole visit, the way a rep does one: it takes the full screen (the
    // shell and the tutorial with it unmount) and hands back when it is done.
    const visit = async () => {
      await go(`/property/${leadId}`)
      await page.getByRole('button', { name: /^Start visit$/ }).first().click()
      await page.waitForTimeout(900)
      await page.getByRole('button', { name: /Interested/ }).first().click()
      await page.waitForTimeout(700)
      await page.getByRole('button', { name: /^Continue$/ }).click()
      await page.waitForTimeout(500)
      await page.getByRole('button', { name: /Complete visit/ }).click()
      await page.waitForTimeout(1200)
    }
    await visit()
    ok((await idb(page, 'visits')).some((v) => v.endedAt), 'a visit was completed', 'the case that remounts the shell')
    ok(!(await shows(2000)), 'after a visit, it does not come back')
    await open(page, `/property/${leadId}?note=1`)
    await page.locator('[role="dialog"] textarea').first().fill('Gate note')
    await page.getByRole('button', { name: 'Save note' }).click()
    ok(!(await shows()), 'after a note, it does not come back')
    await page.getByRole('button', { name: 'Edit details' }).first().click()
    await page.waitForTimeout(500)
    await page.getByTestId('lead-edit-status').selectOption('contacted').catch(() => {})
    await page.getByTestId('lead-edit-save').click()
    ok(!(await shows()), 'after a status change, it does not come back')
    await open(page, '/map')
    await open(page, '/today')
    ok(!(await shows()), 'leaving and coming back, it does not come back')
    await page.reload({ waitUntil: 'domcontentloaded' })
    ok(!(await shows(2200)), 'after a relaunch, it does not come back')

    // A replay from More, then more work: the reported case.
    await go('/more')
    await page.getByRole('button', { name: 'Show the tutorial again' }).click()
    ok(await tour.first().waitFor({ state: 'visible', timeout: 4000 }).then(() => true).catch(() => false), 'Show the tutorial again brings it back when asked')
    await page.locator('[data-tour-skip]').click()
    await page.waitForTimeout(400)
    const back = []
    for (let i = 0; i < 2; i++) {
      await go(`/property/${leadId}`)
      back.push(await shows(1500))
      if (back.at(-1)) await page.locator('[data-tour-skip]').click()
      await visit()
      back.push(await shows(2000))
      if (back.at(-1)) await page.locator('[data-tour-skip]').click()
    }
    const done = (await idb(page, 'visits')).filter((v) => v.endedAt).length
    ok(done >= 3, 'the visits really were completed', `${done} completed`)
    ok(!back.some(Boolean), 'and after a replay, the visits that follow do not bring it back again', back.map((b) => (b ? 'reappeared' : 'stayed away')).join(', '))

    // Another person on this phone gets their own; the first keeps theirs.
    await open(page, '/more')
    await page.getByTestId('sign-out').click()
    await page.getByRole('button', { name: /^Sign out$/ }).last().click()
    await page.waitForTimeout(1200)
    await demo(/Ray Okafor/)
    ok(await tour.first().waitFor({ state: 'visible', timeout: 4000 }).then(() => true).catch(() => false), 'a different person, in a different role, sees their own tutorial')
    await page.locator('[data-tour-skip]').click()
    await page.waitForTimeout(400)
    await open(page, '/more')
    await page.getByTestId('sign-out').click()
    await page.getByRole('button', { name: /^Sign out$/ }).last().click()
    await page.waitForTimeout(1200)
    await demo(/Dana Whitfield/)
    ok(!(await shows(2200)), 'and the first, signing back in, is not shown it again')
    const meta = await page.evaluate(() => new Promise((res) => {
      const q = indexedDB.open('allstar-field')
      q.onsuccess = () => { const r = q.result.transaction('meta').objectStore('meta').getAllKeys(); r.onsuccess = () => res(r.result) }
    }))
    ok(meta.some((k) => /^allstar\.tour\.v\d+:field_rep:/.test(k)) && meta.some((k) => /^allstar\.tour\.v\d+:manager:/.test(k)), 'kept per version, role and person', meta.filter((k) => /tour/.test(k)).join(', '))
    await ctx.close()
  }
  {
    // Someone who finished it before this update is not shown it again.
    const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, serviceWorkers: 'block' })
    const page = await ctx.newPage()
    await page.route('**://maps.googleapis.com/**', (r) => r.abort())
    await page.goto(BASE, { waitUntil: 'domcontentloaded' })
    await page.waitForTimeout(1000)
    await page.evaluate(() => new Promise((res) => {
      const q = indexedDB.open('allstar-field')
      q.onsuccess = () => { const t = q.result.transaction('meta', 'readwrite'); t.objectStore('meta').put(true, 'allstar.tour.v2'); t.oncomplete = () => res() }
    }))
    await page.getByRole('button', { name: /Try the demo/ }).click()
    await page.getByRole('button', { name: /Dana Whitfield/ }).click()
    await page.waitForTimeout(2200)
    ok(!(await page.locator('[data-tour-card]').isVisible().catch(() => false)), 'a phone that had finished the tutorial before this update is not shown it again')
    await ctx.close()
  }
} catch (err) {
  console.error(err)
  fails.push(String(err))
} finally {
  await browser.close()
}

ok(errors.length === 0, 'no page errors', errors.join(' | '))
if (fails.length) {
  console.log(`\n${fails.length} failed:`)
  fails.forEach((f) => console.log(`  - ${f}`))
  process.exit(1)
}
console.log('\n=== photos kept, calls handed off, the tutorial finished for good ===')
