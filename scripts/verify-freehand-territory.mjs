import { chromium } from 'playwright'
import { chromiumPath } from './lib/browser.mjs'
import { dismissTour } from './lib/tour.mjs'

/**
 * Drawing a territory freehand, and keeping it.
 *
 * `verify:freehand-ui` covers the lead map's selection tool. This is the screen
 * where an outline becomes a saved, named territory: that Draw freehand sits beside
 * Tap corners without replacing it, that the outline a finger draws is the one that
 * is counted and stored, and that the count the manager saw is the number of leads
 * the stored boundary actually contains.
 *
 * That last claim is the one worth checking from outside the code that makes it.
 * The number on screen comes from the app's own point-in-polygon over its own
 * points; here it is recomputed from what ended up in the database — the saved
 * boundary against every stored lead — with a separate ray-casting test, so a
 * projection that is subtly off shows up as a disagreement, not a plausible number.
 *
 * Demo mode: creation is local-first, which is the path a manager in a dead zone
 * takes and the one nothing else covers.
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
const shownCount = async (page) => {
  const t = await text(page.locator('#territory-create-panel'))
  const m = /([\d,]+)\s+leads?\s+inside/.exec(t)
  return m ? Number(m[1].replace(/,/g, '')) : null
}

/** A rounded loop round a box, one point every few pixels. */
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
async function drawWithMouse(page, pts) {
  await page.mouse.move(pts[0].x, pts[0].y)
  await page.mouse.down()
  for (const p of pts.slice(1)) await page.mouse.move(p.x, p.y)
  await page.mouse.up()
  await page.waitForTimeout(300)
}
async function drawWithTouch(cdp, page, pts) {
  const t = (type, points) => cdp.send('Input.dispatchTouchEvent', { type, touchPoints: points })
  await t('touchStart', [{ x: pts[0].x, y: pts[0].y, id: 1 }])
  for (const p of pts.slice(1)) await t('touchMove', [{ x: p.x, y: p.y, id: 1 }])
  await t('touchEnd', [])
  await page.waitForTimeout(300)
}

async function openCreate(ctx) {
  const page = await ctx.newPage()
  const errors = []
  page.on('pageerror', (e) => errors.push(e.message))
  await page.route(/maps\.googleapis\.com/, (r) => r.abort())
  await page.goto(BASE, { waitUntil: 'domcontentloaded' })
  await page.waitForTimeout(1200)
  await page.getByRole('button', { name: /Try the demo/ }).click()
  await page.getByRole('button', { name: /Nadia Petrov/ }).click()
  await dismissTour(page)
  await page.waitForTimeout(2200)
  await page.goto(`${BASE}/admin/territories`, { waitUntil: 'domcontentloaded' })
  await page.waitForTimeout(1600)
  await page.getByTestId('territory-create-toggle').click()
  await page.waitForTimeout(700)
  const map = page.getByRole('application', { name: /Outline a territory/ })
  await map.scrollIntoViewIfNeeded()
  await page.waitForTimeout(400)
  return { page, errors, map }
}

for (const [label, viewport, touch] of [
  ['desktop', { width: 1280, height: 900 }, false],
  ['phone', { width: 390, height: 900 }, true],
  ['iPad', { width: 820, height: 1180 }, true],
]) {
  const tag = (s) => `${label}: ${s}`
  const ctx = await browser.newContext({ viewport, isMobile: touch, hasTouch: touch, serviceWorkers: 'block' })
  const { page, errors, map } = await openCreate(ctx)
  const cdp = touch ? await ctx.newCDPSession(page) : null
  const draw = (pts) => (touch ? drawWithTouch(cdp, page, pts) : drawWithMouse(page, pts))
  const mapBox = async () => (await page.getByRole('application', { name: /Outline a territory|Territory outline/ }).first().boundingBox())

  /* --- both ways of drawing are offered, and tapping is still the default --------- */
  const tap = page.getByTestId('territory-style-tap')
  const free = page.getByTestId('territory-style-freehand')
  ok((await text(tap)) === 'Tap corners' && (await text(free)) === 'Draw freehand', tag('the screen offers Tap corners and Draw freehand'))
  ok((await tap.getAttribute('aria-pressed')) === 'true', tag('tapping corners is the one on, as before'))
  ok((await page.getByRole('button', { name: /Undo point/ }).count()) === 1, tag('with its Undo point'))
  ok((await page.getByTestId('freehand-layer').count()) === 0, tag('and nothing covering the map'))

  // Tapping still works.
  let box = await mapBox()
  if (touch) await page.touchscreen.tap(box.x + box.width * 0.4, box.y + box.height * 0.4)
  else await page.mouse.click(box.x + box.width * 0.4, box.y + box.height * 0.4)
  await page.waitForTimeout(350)
  ok((await page.locator('[data-draw="territory"] circle').count()) === 1, tag('a tap still drops a corner'))

  /* --- freehand: switching starts the shape again -------------------------------- */
  await free.click()
  await page.waitForTimeout(300)
  ok((await free.getAttribute('aria-pressed')) === 'true' && (await tap.getAttribute('aria-pressed')) === 'false', tag('Draw freehand shows as the active one'))
  ok((await page.locator('[data-draw="territory"] circle').count()) === 0, tag('and the tapped corner is gone: the two are not mixed into one shape'))
  ok((await page.getByTestId('freehand-layer').count()) === 1 && (await page.getByTestId('freehand-hint').isVisible()), tag('the drawing surface is up with its instruction'))
  ok((await page.getByRole('button', { name: /Undo point/ }).count()) === 0, tag('Undo point is put away, as there are no points to undo'))
  ok(/Drag your finger to outline a territory/.test(await text(page.locator('#territory-create-panel'))), tag('and the panel says how to draw'))
  ok((await page.getByRole('button', { name: 'Zoom in' }).isVisible()), tag('the zoom buttons are still there'))

  /* --- a bad stroke, then a good one -------------------------------------------- */
  box = await mapBox()
  await draw([{ x: box.x + box.width * 0.5, y: box.y + box.height * 0.5 }])
  const note = page.getByTestId('territory-freehand-note')
  ok(/too short/.test(await text(note)) && (await note.getAttribute('role')) === 'alert', tag('a tap is too short and says so, as an alert'), await note.count() ? await text(note) : 'no note')
  ok((await page.getByTestId('freehand-layer').count()) === 1, tag('and the surface is still there for another go'))

  const before = (await readStore(page, 'properties')).length
  const territoriesBefore = (await readStore(page, 'territories')).length
  box = await mapBox()
  const fx0 = box.x + box.width * 0.22
  const fy0 = box.y + box.height * 0.2
  const fx1 = box.x + box.width * 0.78
  const fy1 = box.y + box.height * 0.8
  await draw(loop(fx0, fy0, fx1, fy1))
  ok((await page.getByTestId('freehand-layer').count()) === 0, tag('lifting the finger takes the surface away'))
  ok((await page.locator('[data-draw="territory"] path').count()) === 1, tag('and leaves the outline on the map'))
  ok((await page.locator('[data-draw="territory"] circle').count()) === 0, tag('with no dot on every corner'))
  const n = await shownCount(page)
  ok(n !== null && n > 0, tag('the panel counts the leads inside'), `${n}`)
  ok((await page.getByTestId('territory-freehand-note').count()) === 0 || !/too short/.test(await text(page.getByTestId('territory-freehand-note'))), tag('and the earlier complaint is gone'))

  /* --- name it, save it, then check it from the database -------------------------- */
  await page.getByTestId('territory-name').fill(`Gate Freehand ${label}`)
  await page.getByTestId('territory-create-submit').click()
  await page.waitForTimeout(1500)
  const territories = await readStore(page, 'territories')
  const made = territories.find((t) => t.name === `Gate Freehand ${label}`)
  ok(territories.length === territoriesBefore + 1 && !!made, tag('saving makes one territory with the name given'))
  const boundary = made?.boundary ?? []
  ok(boundary.length >= 3 && boundary.length <= 120, tag('its boundary is a modest outline, inside what the server accepts'), `${boundary.length} points`)
  ok(boundary.every((p) => Number.isFinite(p.lat) && Number.isFinite(p.lng) && Math.abs(p.lat) <= 90 && Math.abs(p.lng) <= 180), tag('of real coordinates'))
  const props = await readStore(page, 'properties')
  const independent = props.filter((p) => Number.isFinite(p.lat) && Number.isFinite(p.lng) && inside(p, boundary)).length
  ok(n === independent, tag('the count shown is what the saved boundary holds, recomputed from the database'), `${n} shown, ${independent} counted`)
  const claimed = props.filter((p) => p.territoryId === made?.id).length
  ok(claimed === independent, tag('and the leads now filed under it are exactly those'), `${claimed}`)
  ok(props.length === before, tag('no lead was created or removed by drawing'), `${props.length} vs ${before}`)

  ok(errors.length === 0, tag('no page errors'), errors.join(' | '))
  await ctx.close()
}

await browser.close()
console.log(fails.length ? `\n${fails.length} FAILED` : '\nAll checks passed')
process.exit(fails.length ? 1 : 0)
