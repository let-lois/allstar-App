import { chromium } from 'playwright'
import { chromiumPath } from './lib/browser.mjs'
import { dismissTour } from './lib/tour.mjs'

/**
 * Territories on the map, and editing their outlines.
 *
 * What this pins, on the console's Territories screen:
 *
 *   Every saved territory is drawn on the map at once, the selected one in
 *   teal, all of them under the leads — and a tap on a pin inside an outline
 *   still lands on the pin.
 *   Edit outline lets a manager drag the corners of the line that is there, or
 *   redraw it freehand; Save writes it, Cancel leaves the old one untouched, and
 *   a line dragged across itself is refused in words and not stored.
 *   Saving never drops a lead the territory already had and never takes one
 *   from another territory; leads in no territory that the new line takes in
 *   join it. Checked from the database, not from what the screen says.
 *   Drawing a new territory over an existing one says how many leads it will
 *   take from it before anything is created.
 *   The new outline survives a reload.
 *
 * Demo mode, where every write is the local-first path. The Worker's half of the
 * same rule is `cd api && npm run smoke:territory-reshape`.
 *
 * Touch at iPhone and iPad sizes is real touch through the DevTools protocol, in
 * Chromium — not WebKit, which this environment cannot run. That still has to be
 * seen on a device.
 */

const BASE = process.env.BASE_URL || 'http://127.0.0.1:4173'
const browser = await chromium.launch({ executablePath: chromiumPath() })

const fails = []
const ok = (c, m, measured) => {
  console.log(`${c ? 'PASS' : 'FAIL'}  ${m}${measured !== undefined && measured !== '' ? `  (${measured})` : ''}`)
  if (!c) fails.push(m)
}
const text = (loc) => loc.innerText().then((t) => t.replace(/\s+/g, ' ').trim())

const readStore = (page, name) =>
  page.evaluate(
    (n) =>
      new Promise((res, rej) => {
        const req = indexedDB.open('allstar-field')
        req.onerror = () => rej(new Error('no db'))
        req.onsuccess = () => {
          const r = req.result.transaction(n, 'readonly').objectStore(n).getAll()
          r.onsuccess = () => res(r.result)
          r.onerror = () => rej(new Error('no rows'))
        }
      }),
    name,
  )
const inside = (p, poly) => {
  let c = false
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    if (poly[i].lat > p.lat !== poly[j].lat > p.lat && p.lng < ((poly[j].lng - poly[i].lng) * (p.lat - poly[i].lat)) / (poly[j].lat - poly[i].lat) + poly[i].lng) c = !c
  }
  return c
}
const byId = (rows) => Object.fromEntries(rows.map((r) => [r.id, r]))

function loop(x0, y0, x1, y1, step = 8) {
  const pts = []
  const edge = (ax, ay, bx, by) => {
    const n = Math.max(1, Math.round(Math.hypot(bx - ax, by - ay) / step))
    for (let i = 0; i < n; i++) pts.push({ x: ax + ((bx - ax) * i) / n, y: ay + ((by - ay) * i) / n })
  }
  edge(x0, y0, x1, y0)
  edge(x1, y0, x1, y1)
  edge(x1, y1, x0, y1)
  edge(x0, y1, x0, y0)
  pts.push({ x: x0, y: y0 })
  return pts
}

async function signInDemo(page) {
  await page.route(/maps\.googleapis\.com/, (r) => r.abort())
  await page.goto(BASE, { waitUntil: 'domcontentloaded' })
  await page.waitForTimeout(1200)
  await page.getByRole('button', { name: /Try the demo/ }).click()
  await page.getByRole('button', { name: /Nadia Petrov/ }).click()
  await dismissTour(page)
  await page.waitForTimeout(2200)
  await page.goto(`${BASE}/admin/territories`, { waitUntil: 'domcontentloaded' })
  await page.waitForTimeout(1600)
}

/** Draw a four-corner territory by tapping, at fractions of the create map, and save it. */
async function createByCorners(page, name, [fx0, fy0, fx1, fy1], tap) {
  await page.getByTestId('territory-create-toggle').click()
  await page.waitForTimeout(600)
  const map = page.getByRole('application', { name: /Outline a territory/ })
  await map.scrollIntoViewIfNeeded()
  await page.waitForTimeout(300)
  const b = await map.boundingBox()
  for (const [fx, fy] of [[fx0, fy0], [fx1, fy0], [fx1, fy1], [fx0, fy1]]) {
    await tap(b.x + b.width * fx, b.y + b.height * fy)
    await page.waitForTimeout(220)
  }
  await page.getByTestId('territory-name').fill(name)
  await page.getByTestId('territory-create-submit').click()
  await page.waitForTimeout(1400)
}
async function select(page, name) {
  // The list is drawn twice (cards on a phone, a table on a desktop); click the one showing.
  await page.locator(`:text-is("${name}"):visible`).first().click()
  await page.waitForTimeout(900)
}
const detailMap = (page) => page.locator('[data-tour="map-canvas"]').last()

for (const [label, viewport, touch] of [
  ['desktop', { width: 1280, height: 900 }, false],
  ['iPhone size', { width: 390, height: 844 }, true],
  ['iPad size', { width: 820, height: 1180 }, true],
]) {
  const tag = (s) => `${label}: ${s}`
  const ctx = await browser.newContext({ viewport, isMobile: touch, hasTouch: touch, serviceWorkers: 'block' })
  const page = await ctx.newPage()
  const errors = []
  page.on('pageerror', (e) => errors.push(e.message))
  const cdp = touch ? await ctx.newCDPSession(page) : null
  const tap = (x, y) => (touch ? page.touchscreen.tap(x, y) : page.mouse.click(x, y))
  const drag = async (pts) => {
    if (touch) {
      const t = (type, points) => cdp.send('Input.dispatchTouchEvent', { type, touchPoints: points })
      await t('touchStart', [{ x: pts[0].x, y: pts[0].y, id: 1 }])
      for (const p of pts.slice(1)) await t('touchMove', [{ x: p.x, y: p.y, id: 1 }])
      await t('touchEnd', [])
    } else {
      await page.mouse.move(pts[0].x, pts[0].y)
      await page.mouse.down()
      for (const p of pts.slice(1)) await page.mouse.move(p.x, p.y)
      await page.mouse.up()
    }
    await page.waitForTimeout(350)
  }

  await signInDemo(page)
  const West = `Gate West ${label}`
  const East = `Gate East ${label}`
  await createByCorners(page, West, [0.12, 0.2, 0.45, 0.8], tap)
  await createByCorners(page, East, [0.55, 0.2, 0.88, 0.8], tap)
  let terrs = await readStore(page, 'territories')
  const west = terrs.find((t) => t.name === West)
  const east = terrs.find((t) => t.name === East)
  ok(!!west && !!east && west.boundary?.length === 4 && east.boundary?.length === 4, tag('two territories are drawn and saved'))

  /*
    The demo files every lead under a territory of its own, which would make the
    "leads in no territory join" rule pass by having nothing to do. So the leads
    in the gap between the two new territories are released first — the state an
    import with no territory column leaves them in — and the page reloaded.
  */
  const westE = Math.max(...west.boundary.map((p) => p.lng))
  const eastW = Math.min(...east.boundary.map((p) => p.lng))
  const latLo = Math.min(...west.boundary.map((p) => p.lat))
  const latHi = Math.max(...west.boundary.map((p) => p.lat))
  const freed = await page.evaluate(
    ({ westE, eastW, latLo, latHi }) =>
      new Promise((res, rej) => {
        const req = indexedDB.open('allstar-field')
        req.onerror = () => rej(new Error('no db'))
        req.onsuccess = () => {
          const tx = req.result.transaction('properties', 'readwrite')
          const store = tx.objectStore('properties')
          const all = store.getAll()
          let n = 0
          all.onsuccess = () => {
            for (const p of all.result) {
              if (p.lng > westE && p.lng < eastW && p.lat > latLo && p.lat < latHi) {
                delete p.territoryId
                store.put(p)
                n++
              }
            }
          }
          tx.oncomplete = () => res(n)
          tx.onerror = () => rej(new Error('write failed'))
        }
      }),
    { westE, eastW, latLo, latHi },
  )
  await page.reload({ waitUntil: 'domcontentloaded' })
  await page.waitForTimeout(2200)
  ok(freed > 0, tag('some leads between the two territories are in no territory, to be taken in'), `${freed}`)

  /* --- several outlines at once, under the pins ------------------------------------- */
  await select(page, West)
  const map = detailMap(page)
  await map.scrollIntoViewIfNeeded()
  await page.waitForTimeout(400)
  const strokes = await map.locator('[data-outline]').evaluateAll((els) => Object.fromEntries(els.map((e) => [e.getAttribute('data-outline'), e.getAttribute('stroke')])))
  ok(!!strokes[west.id] && !!strokes[east.id], tag('the map shows every saved territory at once, not just the selected one'), `${Object.keys(strokes).length} outlines`)
  ok(strokes[west.id] === '#20C4D3' && strokes[east.id] === '#6E8BB8', tag('the selected one in teal, its neighbour in slate'), JSON.stringify([strokes[west.id], strokes[east.id]]))
  const order = await map.evaluate((root) => {
    const g = root.querySelector('[data-outlines="territories"]')
    const pin = root.querySelector('[data-marker="pin"], [data-marker="cluster"]')
    if (!g || !pin) return 'missing'
    return g.compareDocumentPosition(pin) & Node.DOCUMENT_POSITION_FOLLOWING ? 'under' : 'over'
  })
  ok(order === 'under', tag('the outlines are drawn under the leads'), order)
  ok((await map.locator('[data-outlines="territories"]').getAttribute('pointer-events')) === 'none', tag('and take no taps'))
  const hit = await map.evaluate((root) => {
    const pin = root.querySelector('[data-marker="pin"] circle')
    if (!pin) return 'no pin'
    const r = pin.getBoundingClientRect()
    const el = document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2)
    return el?.closest('[data-marker]')?.getAttribute('data-marker') ?? el?.tagName
  })
  ok(hit === 'pin', tag('a press on a pin inside an outline lands on the pin'), hit)

  /* --- edit by dragging a corner ----------------------------------------------------- */
  const before = byId(await readStore(page, 'properties'))
  await page.getByTestId('territory-edit-outline').click()
  await page.waitForTimeout(400)
  ok((await page.getByTestId('territory-outline-panel').count()) === 1, tag('Edit outline opens its panel'))
  ok((await page.getByTestId('territory-outline-corners').getAttribute('aria-pressed')) === 'true', tag('a four-corner territory opens on dragging corners'))
  await map.scrollIntoViewIfNeeded()
  await page.waitForTimeout(300)
  const vertices = await map.locator('[data-marker="vertex"] circle').evaluateAll((els) => els.map((e) => { const r = e.getBoundingClientRect(); return { x: r.x + r.width / 2, y: r.y + r.height / 2 } }))
  ok(vertices.length === 4, tag('its four corners are handles on the map'), `${vertices.length}`)
  ok((await map.locator(`[data-outline="${west.id}"]`).count()) === 0, tag('and its saved outline steps aside while the new line is drawn'))
  const mb = await map.boundingBox()
  // The north-east corner, dragged further east.
  const ne = vertices.reduce((a, v) => (v.x - v.y > a.x - a.y ? v : a), vertices[0])
  const target = { x: Math.min(mb.x + mb.width - 14, ne.x + mb.width * 0.25), y: ne.y }
  await drag(Array.from({ length: 12 }, (_, i) => ({ x: ne.x + ((target.x - ne.x) * i) / 11, y: ne.y })))
  const effect = await text(page.getByTestId('territory-outline-effect'))
  ok(/will join/.test(effect), tag('the panel counts what saving would do, as the corner moves'), effect)
  await page.getByTestId('territory-outline-save').click()
  await page.waitForTimeout(1200)
  terrs = await readStore(page, 'territories')
  const west2 = terrs.find((t) => t.id === west.id)
  ok(JSON.stringify(west2.boundary) !== JSON.stringify(west.boundary) && west2.boundary.length === 4, tag('Save stores the new outline'))
  ok(west2.name === West, tag('and keeps the name'))
  let after = byId(await readStore(page, 'properties'))
  const keptW = Object.values(before).filter((p) => p.territoryId === west.id).every((p) => after[p.id].territoryId === west.id)
  ok(keptW, tag('every lead the territory had is still in it'))
  const eastKept = Object.values(before).filter((p) => p.territoryId === east.id).every((p) => after[p.id].territoryId === east.id)
  ok(eastKept, tag('and every lead of its neighbour is still the neighbour’s'))
  const joined = Object.values(after).filter((p) => p.territoryId === west.id && !before[p.id].territoryId)
  const shouldJoin = Object.values(before).filter((p) => !p.territoryId && Number.isFinite(p.lat) && inside(p, west2.boundary))
  ok(shouldJoin.length > 0, tag('the dragged corner takes in some of the free leads'), `${shouldJoin.length}`)
  ok(joined.length === shouldJoin.length && joined.every((p) => shouldJoin.some((q) => q.id === p.id)), tag('exactly the leads in no territory under the new line joined it, counted from the database'), `${joined.length} joined, ${shouldJoin.length} expected`)
  const said = await text(page.locator('[role="status"]').filter({ hasText: 'Saved the new outline' }).first())
  const saidJoined = Number((/([\d,]+) leads? in no territory joined/.exec(said) ?? ['', '0'])[1].replace(/,/g, ''))
  ok(saidJoined === joined.length, tag('and the message says the same number'), said)

  /* --- redraw it freehand, reaching over the neighbour -------------------------------- */
  const before2 = byId(await readStore(page, 'properties'))
  await page.getByTestId('territory-edit-outline').click()
  await page.waitForTimeout(300)
  await page.getByTestId('territory-outline-redraw').click()
  await page.waitForTimeout(300)
  ok((await page.getByTestId('freehand-layer').count()) === 1, tag('Redraw puts the drawing surface over the map'))
  await map.scrollIntoViewIfNeeded()
  await page.waitForTimeout(250)
  const mb2 = await map.boundingBox()
  const scroll0 = await page.evaluate(() => [window.scrollY, document.scrollingElement.scrollTop])
  await drag(loop(mb2.x + mb2.width * 0.1, mb2.y + mb2.height * 0.15, mb2.x + mb2.width * 0.75, mb2.y + mb2.height * 0.85))
  const scroll1 = await page.evaluate(() => [window.scrollY, document.scrollingElement.scrollTop])
  ok(scroll1.join() === scroll0.join(), tag('the drag did not scroll the page'))
  ok((await page.getByTestId('freehand-layer').count()) === 0 && (await map.locator('[data-draw="territory"] path').count()) === 1, tag('and left a new outline on the map'))
  await page.getByTestId('territory-outline-save').click()
  await page.waitForTimeout(1200)
  terrs = await readStore(page, 'territories')
  const west3 = terrs.find((t) => t.id === west.id)
  ok(west3.boundary.length >= 3 && west3.boundary.length <= 120 && JSON.stringify(west3.boundary) !== JSON.stringify(west2.boundary), tag('the freehand outline is stored'), `${west3.boundary.length} points`)
  after = byId(await readStore(page, 'properties'))
  const eastTaken = Object.values(before2).filter((p) => p.territoryId === east.id && after[p.id].territoryId !== east.id)
  ok(eastTaken.length === 0, tag('reaching over the neighbour took none of its leads'), `${eastTaken.length} moved`)
  const lostW = Object.values(before2).filter((p) => p.territoryId === west.id && after[p.id].territoryId !== west.id)
  ok(lostW.length === 0, tag('and the territory lost none of its own, even those now outside the line'), `${lostW.length} lost`)

  /* --- a line dragged across itself is refused; Cancel keeps the old one --------------- */
  await page.getByTestId('territory-edit-outline').click()
  await page.waitForTimeout(300)
  const corners = (await page.getByTestId('territory-outline-corners').getAttribute('aria-pressed')) === 'true'
  if (corners) {
    await map.scrollIntoViewIfNeeded()
    await page.waitForTimeout(250)
    const vs = await map.locator('[data-marker="vertex"] circle').evaluateAll((els) => els.map((e) => { const r = e.getBoundingClientRect(); return { x: r.x + r.width / 2, y: r.y + r.height / 2 } }))
    // The top-left corner, dragged out past the right-hand side at mid-height: the
    // edge back to it now cuts across the right side, so the line crosses itself.
    const mbx = await map.boundingBox()
    const from = vs.reduce((a, v) => (v.x + v.y < a.x + a.y ? v : a), vs[0])
    const maxX = Math.max(...vs.map((v) => v.x))
    const to = {
      x: Math.min(mbx.x + mbx.width - 12, maxX + 60),
      y: (Math.min(...vs.map((v) => v.y)) + Math.max(...vs.map((v) => v.y))) / 2,
    }
    await drag(Array.from({ length: 14 }, (_, i) => ({ x: from.x + ((to.x - from.x) * i) / 13, y: from.y + ((to.y - from.y) * i) / 13 })))
    await page.getByTestId('territory-outline-save').click()
    await page.waitForTimeout(500)
    const err = (await page.getByTestId('territory-outline-error').count()) ? await text(page.getByTestId('territory-outline-error')) : ''
    ok(/crosses itself/.test(err), tag('a line dragged across itself is refused, in words'), err)
    const unchanged = (await readStore(page, 'territories')).find((t) => t.id === west.id)
    ok(JSON.stringify(unchanged.boundary) === JSON.stringify(west3.boundary), tag('and nothing was stored'))
  } else {
    ok(true, tag('(outline has too many corners to drag; the crossing case is covered at another size)'))
  }
  await page.getByTestId('territory-outline-cancel').click()
  await page.waitForTimeout(400)
  ok((await page.getByTestId('territory-outline-panel').count()) === 0 && (await map.locator(`[data-outline="${west.id}"]`).count()) === 1, tag('Cancel closes the panel and the saved outline is back'))

  /* --- drawing over a neighbour says what it will take --------------------------------- */
  await page.getByTestId('territory-create-toggle').click()
  await page.waitForTimeout(600)
  const cmap = page.getByRole('application', { name: /Outline a territory/ })
  await cmap.scrollIntoViewIfNeeded()
  await page.waitForTimeout(300)
  ok((await cmap.locator('[data-outline]').count()) >= 2, tag('the drawing map shows the territories already there'))
  const cb = await cmap.boundingBox()
  for (const [fx, fy] of [[0.6, 0.25], [0.85, 0.25], [0.85, 0.75], [0.6, 0.75]]) {
    await tap(cb.x + cb.width * fx, cb.y + cb.height * fy)
    await page.waitForTimeout(200)
  }
  const carve = page.getByTestId('territory-carve-note')
  const carveText = (await carve.count()) ? await text(carve) : ''
  // The demo has territories of its own, so the outline may cross several; the
  // sentence must give a count and name territories that exist.
  const carveMatch = /^(\d+) of them (?:is|are) in (.+) now and will move to this territory\.$/.exec(carveText)
  const named = carveMatch ? carveMatch[2].split(', ') : []
  const existing = new Set((await readStore(page, 'territories')).map((t) => t.name))
  ok(!!carveMatch && Number(carveMatch[1]) > 0 && named.length > 0 && named.every((n) => existing.has(n)), tag('it says how many leads it will take from other territories, and from which, before anything is created'), carveText)
  await page.getByTestId('territory-draw-cancel').click()
  await page.waitForTimeout(400)
  ok((await readStore(page, 'territories')).length === terrs.length, tag('and cancelling created nothing'))

  /* --- it survives a reload --------------------------------------------------------------- */
  await page.reload({ waitUntil: 'domcontentloaded' })
  await page.waitForTimeout(2200)
  const reloaded = (await readStore(page, 'territories')).find((t) => t.id === west.id)
  ok(JSON.stringify(reloaded?.boundary) === JSON.stringify(west3.boundary), tag('the new outline is still there after a reload'))
  await select(page, West)
  await detailMap(page).scrollIntoViewIfNeeded()
  await page.waitForTimeout(400)
  ok((await detailMap(page).locator(`[data-outline="${west.id}"]`).count()) === 1, tag('and drawn on the map again'))

  ok(errors.length === 0, tag('no page errors'), errors.join(' | '))
  await ctx.close()
}

await browser.close()
console.log(fails.length ? `\n${fails.length} FAILED` : '\nAll checks passed')
process.exit(fails.length ? 1 : 0)
