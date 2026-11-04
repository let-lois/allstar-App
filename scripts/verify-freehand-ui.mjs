import { chromium } from 'playwright'
import { chromiumPath } from './lib/browser.mjs'
import { dismissTour } from './lib/tour.mjs'

/**
 * Drawing a territory on the console's lead map, as a person would.
 *
 * `verify:freehand` pins the geometry. This is the screen: that Draw territory
 * is a tool beside Select pins and not a replacement for it, that a dragged
 * finger (or mouse) leaves a line while it moves and a filled shape when it
 * lifts, that the map does not move under it, that the leads counted are the
 * leads inside the line you can see, that Select adds them to the selection and
 * changes nothing else, that a tap, a straight line and a figure-eight each get
 * a plain sentence and leave the map ready for another go, that a second finger
 * abandons the stroke, and that once drawing is over the map pans, zooms and
 * selects pins exactly as before.
 *
 * Run at desktop, phone and iPad sizes; the two touch sizes drive the layer with
 * real touch events (through the DevTools protocol), because a mouse never
 * exercises `touch-action` or a second finger. What this cannot do is run WebKit
 * or an Android WebView — those are Chromium here, so the iOS and Android
 * results are the same engine at their screen sizes. The pointer events and
 * touch-action it relies on are the same ones both webviews implement.
 */

const BASE = process.env.BASE_URL || 'http://127.0.0.1:4173'
const browser = await chromium.launch({ executablePath: chromiumPath() })

const fails = []
const ok = (c, m, measured) => {
  console.log(`${c ? 'PASS' : 'FAIL'}  ${m}${measured !== undefined && measured !== '' ? `  (${measured})` : ''}`)
  if (!c) fails.push(m)
}
const json = (status, obj) => ({ status, contentType: 'application/json', body: JSON.stringify(obj) })
const text = (loc) => loc.innerText().then((t) => t.replace(/\s+/g, ' ').trim())

/* ---- a grid of leads far enough apart that none cluster ----------------------- */

const COLS = [-2, -1, 0, 1, 2]
const ROWS = [-1, 0, 1]
function makeWorld(role = 'client_admin') {
  const cells = []
  // The middle lead first: the map opens centred on the first lead.
  cells.push([0, 0])
  for (const r of ROWS) for (const c of COLS) if (!(r === 0 && c === 0)) cells.push([c, r])
  const props = cells.map(([c, r], i) => ({
    id: `p${i + 1}`,
    address1: `${100 + i} Gate Grid Rd`,
    city: 'Round Rock', state: 'TX', zip: '78664',
    lat: 30.5083 - r * 0.003, lng: -97.6789 + c * 0.003,
    status: i % 2 === 0 ? 'new' : 'contacted',
    score: 60, assignedRepId: 'u_rep', contacts: [], col: c, row: r,
  }))
  return { role, props, calls: [] }
}
const meOf = (w) => ({
  id: 'u_admin', clientId: 'c_live', clientName: 'Ridgeline Roofing', email: 'nadia@ridgeline.test', name: 'Nadia Petrov', role: w.role,
  onboarding: { status: 'complete', version: 1, completedAt: Date.now() - 86_400_000 }, badge: null,
  company: { name: 'Ridgeline Roofing', timezone: 'America/Chicago' },
})
async function mockApi(page, w) {
  await page.route('**/api/**', (r) => r.fulfill(json(200, {})))
  await page.route('**/api/auth/login', (r) => r.fulfill(json(200, { token: 'tok', user: meOf(w) })))
  await page.route('**/api/me', (r) => r.fulfill(json(200, { user: meOf(w) })))
  await page.route('**/api/bootstrap', (r) =>
    r.fulfill(json(200, { user: meOf(w), properties: w.props.map(({ col, row, ...p }) => p), routes: [], appointments: [], tasks: [], activity: [], dailyStats: [], territories: [], erased: [], serverTime: Date.now() })),
  )
  await page.route('**/api/users', (r) => r.fulfill(json(200, { users: [] })))
  // Any write the screen might make is recorded: drawing must make none.
  for (const pattern of ['**/api/leads/**', '**/api/properties/**', '**/api/territories**', '**/api/lists**']) {
    await page.route(pattern, (r) => {
      if (r.request().method() !== 'GET') w.calls.push(`${r.request().method()} ${new URL(r.request().url()).pathname}`)
      return r.fulfill(json(200, {}))
    })
  }
  await page.route(/maps\.googleapis\.com/, (r) => r.abort())
}
async function signIn(page) {
  await page.goto(BASE, { waitUntil: 'domcontentloaded' })
  await page.waitForTimeout(900)
  await page.locator('input[type="email"]').first().fill('nadia@ridgeline.test')
  await page.locator('input[autocomplete="current-password"]').fill('a-real-password')
  await page.getByRole('button', { name: /^Sign in$/ }).click()
  await page.waitForTimeout(1600)
  await dismissTour(page)
}

/* ---- helpers: where things are, and drawing ------------------------------------ */

const pins = (page) =>
  page.locator('[data-marker="pin"]').evaluateAll((els) =>
    els.map((e) => {
      const r = e.querySelector('circle').getBoundingClientRect()
      return { id: e.dataset.id, x: r.x + r.width / 2, y: r.y + r.height / 2, halo: e.querySelectorAll('circle[opacity="0.2"]').length > 0 }
    }),
  )
const marked = async (page) => (await pins(page)).filter((p) => p.halo).map((p) => p.id).sort()
const bulk = async (page) => ((await page.getByTestId('bulk-count').count()) ? text(page.getByTestId('bulk-count')) : 'none')
const layer = (page) => page.getByTestId('freehand-layer')
const count = async (page) => ((await page.getByTestId('freehand-count').count()) ? text(page.getByTestId('freehand-count')) : '')
const errorText = async (page) => ((await page.getByTestId('freehand-error').count()) ? text(page.getByTestId('freehand-error')) : '')

/** Points of a rounded loop round a box, one every `step` pixels, ending back at the start. */
function loop(box, { step = 7, overshoot = 0 } = {}) {
  const { x0, y0, x1, y1 } = box
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
  // Run on past the start — up and over, then back down across the top edge — so
  // the end of the line crosses the beginning of it, once, as a hand does.
  if (overshoot) {
    pts.push({ x: x0 - 4, y: y0 - overshoot * 0.4 })
    pts.push({ x: x0 + overshoot * 0.35, y: y0 - overshoot * 0.6 })
    pts.push({ x: x0 + overshoot * 0.9, y: y0 + overshoot * 0.4 })
  }
  return pts
}
const inside = (p, poly) => {
  let c = false
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    if (poly[i].y > p.y !== poly[j].y > p.y && p.x < ((poly[j].x - poly[i].x) * (p.y - poly[i].y)) / (poly[j].y - poly[i].y) + poly[i].x) c = !c
  }
  return c
}

async function drawWithMouse(page, pts) {
  await page.mouse.move(pts[0].x, pts[0].y)
  await page.mouse.down()
  for (const p of pts.slice(1)) await page.mouse.move(p.x, p.y)
  await page.mouse.up()
  await page.waitForTimeout(250)
}
async function touchDraw(cdp, page, pts, { second = null } = {}) {
  const t = (type, points) => cdp.send('Input.dispatchTouchEvent', { type, touchPoints: points })
  await t('touchStart', [{ x: pts[0].x, y: pts[0].y, id: 1 }])
  if (second) await t('touchStart', [{ x: pts[0].x, y: pts[0].y, id: 1 }, { x: second.x, y: second.y, id: 2 }])
  for (const p of pts.slice(1)) await t('touchMove', second ? [{ x: p.x, y: p.y, id: 1 }, { x: second.x, y: second.y, id: 2 }] : [{ x: p.x, y: p.y, id: 1 }])
  await t('touchEnd', [])
  await page.waitForTimeout(300)
}

/** A box round the leads in the given columns/rows, using where the pins really are. */
async function boxAround(page, w, cols, rows, pad = 62) {
  const on = await pins(page)
  const chosen = w.props.filter((p) => cols.includes(p.col) && rows.includes(p.row)).map((p) => on.find((o) => o.id === p.id)).filter(Boolean)
  return {
    chosen: chosen.map((c) => c.id),
    box: {
      x0: Math.min(...chosen.map((c) => c.x)) - pad,
      y0: Math.min(...chosen.map((c) => c.y)) - pad,
      x1: Math.max(...chosen.map((c) => c.x)) + pad,
      y1: Math.max(...chosen.map((c) => c.y)) + pad,
    },
  }
}

/** Measure where the leads are *now* and draw round the given ones: the map moves when the bulk bar comes and goes. */
async function drawAround(page, w, cols, rows, opts = {}) {
  const region = await boxAround(page, w, cols, rows, opts.pad)
  await drawWithMouse(page, loop(region.box, opts))
  return region
}

async function open(ctx, w) {
  const page = await ctx.newPage()
  const errors = []
  page.on('pageerror', (e) => errors.push(e.message))
  await mockApi(page, w)
  await signIn(page)
  await page.goto(`${BASE}/admin/leads`, { waitUntil: 'domcontentloaded' })
  await page.waitForTimeout(1500)
  await dismissTour(page)
  await page.getByRole('group', { name: 'View' }).getByRole('button', { name: /map/i }).click()
  await page.waitForTimeout(1500)
  return { page, errors }
}

/* =============================================================================== */
/* desktop, with a mouse                                                            */
/* =============================================================================== */
{
  const w = makeWorld()
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 900 }, serviceWorkers: 'block' })
  const { page, errors } = await open(ctx, w)
  const all = await pins(page)
  ok(all.length === w.props.length, 'every lead is a pin on the map, none clustered', `${all.length} of ${w.props.length}`)

  /* --- the two tools ------------------------------------------------------------- */
  const pinsTool = page.getByTestId('map-tool-pins')
  const drawTool = page.getByTestId('map-tool-territory')
  ok((await pinsTool.innerText()) === 'Select pins' && (await drawTool.innerText()) === 'Draw territory', 'the map has a Select pins tool and a Draw territory tool')
  ok((await pinsTool.getAttribute('aria-pressed')) === 'true' && (await drawTool.getAttribute('aria-pressed')) === 'false', 'Select pins is the one on, as before')
  ok((await layer(page).count()) === 0, 'and nothing is covering the map')
  ok((await page.getByRole('button', { name: 'Select an area' }).count()) === 1, 'the tap-by-tap area is still offered')

  /* --- the existing pin tool, untouched --------------------------------------------- */
  await page.mouse.click(all[3].x, all[3].y)
  await page.waitForTimeout(300)
  ok((await bulk(page)) === '1 selected', 'tapping a pin selects it, as it always did', await bulk(page))
  ok((await marked(page)).join() === all[3].id, 'and the map now shows which lead is chosen')
  // The bulk bar has appeared above the map and pushed it down: measure again.
  const again = (await pins(page)).find((p) => p.id === all[3].id)
  await page.mouse.click(again.x, again.y)
  await page.waitForTimeout(300)
  ok((await bulk(page)) === 'none' && (await marked(page)).length === 0, 'tapping it again unselects it, and the halo goes')

  // The old tap-by-tap area, round the whole grid.
  {
    const { chosen, box } = await boxAround(page, w, COLS, ROWS, 50)
    await page.getByRole('button', { name: 'Select an area' }).click()
    for (const [x, y] of [[box.x0, box.y0], [box.x1, box.y0], [box.x1, box.y1], [box.x0, box.y1]]) {
      await page.mouse.click(x, y)
      await page.waitForTimeout(120)
    }
    ok(/\d+ leads? inside/.test(await text(page.locator('section').filter({ hasText: 'inside' }).first())), 'the tap-by-tap area still counts the leads inside it')
    await page.getByRole('button', { name: /^Add \d+ to selection$/ }).click()
    await page.waitForTimeout(250)
    ok((await bulk(page)) === `${chosen.length} selected`, 'and still adds them to the selection', await bulk(page))
    await page.getByTestId('bulk-clear').click()
  }

  /* --- switching to Draw territory ---------------------------------------------------- */
  await drawTool.click()
  await page.waitForTimeout(300)
  ok((await drawTool.getAttribute('aria-pressed')) === 'true' && (await pinsTool.getAttribute('aria-pressed')) === 'false', 'Draw territory shows as the active tool')
  ok((await layer(page).count()) === 1, 'and the drawing surface is over the map')
  ok((await text(page.getByTestId('freehand-hint'))) === 'Drag your finger to outline a territory.', 'with the instruction on it', await text(page.getByTestId('freehand-hint')))
  ok((await page.getByRole('button', { name: 'Select an area' }).count()) === 0, 'and the tap-by-tap button is put away while it is')
  ok((await page.getByRole('button', { name: 'Zoom in' }).isVisible()) && (await page.getByRole('button', { name: 'Zoom out' }).isVisible()), 'the zoom buttons are still showing')

  /* --- a stroke that starts on a pin, round six leads ----------------------------------- */
  const before = await pins(page)
  const six = await boxAround(page, w, [-2, -1], ROWS)
  ok(six.chosen.length === 6, 'six leads to draw round', six.chosen.join())
  const path = loop(six.box)
  // Start the stroke on top of a pin on purpose: it must not be selected.
  const onPin = before.find((p) => p.id === six.chosen[0])
  path.unshift({ x: onPin.x, y: onPin.y })
  path.unshift({ x: onPin.x, y: onPin.y })
  await page.mouse.move(path[0].x, path[0].y)
  await page.mouse.down()
  for (const p of path.slice(1, 14)) await page.mouse.move(p.x, p.y)
  const live = await page.getByTestId('freehand-trace').count()
  const livePath = live ? await page.getByTestId('freehand-trace').locator('path').first().getAttribute('d') : ''
  ok(live === 1 && /^M/.test(livePath) && livePath.split('L').length > 3, 'while the finger moves a line is drawn on the map in real time', `${livePath.split('L').length} points`)
  ok((await page.getByTestId('freehand-hint').count()) === 0, 'and the instruction gets out of the way of it')
  for (const p of path.slice(14)) await page.mouse.move(p.x, p.y)
  await page.mouse.up()
  await page.waitForTimeout(350)

  const after = await pins(page)
  const drift = Math.max(...before.map((b) => Math.hypot(b.x - after.find((a) => a.id === b.id).x, b.y - after.find((a) => a.id === b.id).y)))
  ok(drift < 0.5, 'the map did not move while the outline was drawn', `${drift.toFixed(2)}px`)
  ok((await bulk(page)) === 'none' && !/\/property\//.test(page.url()), 'and a pin the stroke started on was neither selected nor opened')
  ok((await layer(page).count()) === 0, 'the drawing surface goes when the finger lifts, so the map is the map again')
  ok((await page.locator('[data-draw="territory"] path').count()) === 1, 'the outline stays on the map as a closed shape')
  const fill = await page.locator('[data-draw="territory"] path').first().evaluate((e) => ({ fill: e.getAttribute('fill'), op: e.getAttribute('fill-opacity'), d: e.getAttribute('d') }))
  ok(fill.fill !== 'none' && Number(fill.op) > 0 && Number(fill.op) < 0.5 && /Z$/.test(fill.d), 'with a see-through fill and its line closed', `fill-opacity ${fill.op}`)
  ok((await page.locator('[data-draw="territory"] circle').count()) === 0, 'and no dot on every corner of it')

  ok((await count(page)).startsWith('6 leads inside'), 'it says how many leads are inside', await count(page))
  ok(/acres|sq mi/.test(await count(page)), 'and how big the area is', await count(page))
  const apply = page.getByTestId('freehand-apply')
  ok((await text(apply)) === 'Select 6 leads', 'one button selects them, and says how many', await text(apply))
  ok((await page.getByTestId('freehand-redraw').count()) === 1 && (await page.getByTestId('freehand-cancel').count()) === 1, 'beside Redraw and Cancel')
  ok(w.calls.length === 0, 'nothing has been written — drawing is not an edit', w.calls.join(', '))

  // The count is the leads inside the line that is on screen.
  const drawn = path.slice(2)
  const expected = after.filter((p) => inside(p, drawn)).map((p) => p.id).sort()
  ok(expected.join() === six.chosen.slice().sort().join(), 'the six are the six inside the line on screen', expected.join())

  await apply.click()
  await page.waitForTimeout(300)
  ok((await bulk(page)) === '6 selected', 'selecting adds them to the selection the bulk bar already uses', await bulk(page))
  ok((await marked(page)).join() === six.chosen.slice().sort().join(), 'and they are the ones drawn as chosen on the map, and no others', (await marked(page)).join())
  ok((await page.locator('[data-draw="territory"]').count()) === 0 && (await layer(page).count()) === 1, 'the outline clears and the tool is ready for another')
  ok(w.calls.length === 0, 'still nothing written', w.calls.join(', '))

  /* --- redraw and cancel -------------------------------------------------------------------- */
  await drawAround(page, w, [1, 2], ROWS)
  ok((await count(page)).startsWith('6 leads inside'), 'a second outline counts its own six', await count(page))
  await page.getByTestId('freehand-apply').click()
  await page.waitForTimeout(250)
  ok((await bulk(page)) === '12 selected', 'and adds to the first six rather than replacing them', await bulk(page))
  await page.getByTestId('bulk-clear').click()

  await drawAround(page, w, [-2, -1], ROWS)
  await page.getByTestId('freehand-redraw').click()
  await page.waitForTimeout(250)
  ok((await page.locator('[data-draw="territory"]').count()) === 0 && (await layer(page).count()) === 1 && (await count(page)) === '', 'Redraw throws the outline away and hands the map back to be drawn on')
  await drawAround(page, w, [1, 2], ROWS)
  ok((await count(page)).startsWith('6 leads inside'), 'and the new outline replaces it', await count(page))
  await page.getByTestId('freehand-cancel').click()
  await page.waitForTimeout(250)
  ok((await page.locator('[data-draw="territory"]').count()) === 0 && (await layer(page).count()) === 0, 'Cancel puts the outline away and leaves drawing')
  ok((await pinsTool.getAttribute('aria-pressed')) === 'true' && (await bulk(page)) === 'none', 'back on Select pins with nothing selected')

  /* --- switching tools with a drawing on the map ---------------------------------------------------- */
  await drawTool.click()
  await drawAround(page, w, [-2, -1], ROWS)
  await pinsTool.click()
  await page.waitForTimeout(250)
  ok((await page.locator('[data-draw="territory"]').count()) === 0 && (await count(page)) === '', 'switching back to Select pins drops the unfinished outline')

  /* --- an area with nothing in it ------------------------------------------------------------------------- */
  await drawTool.click()
  const mapBox = await page.locator('[data-tour="map-canvas"]').first().boundingBox()
  const empty = { x0: mapBox.x + 12, y0: mapBox.y + 14, x1: mapBox.x + 80, y1: mapBox.y + 70 }
  await drawWithMouse(page, loop(empty, { step: 5 }))
  ok((await count(page)).startsWith('No leads inside this outline'), 'an area with no leads says so', await count(page))
  ok(await page.getByTestId('freehand-apply').isDisabled(), 'and cannot be applied')
  await page.getByTestId('freehand-redraw').click()

  /* --- bad strokes get a sentence and another go ------------------------------------------------------------- */
  await page.mouse.click(mapBox.x + 300, mapBox.y + 250)
  await page.waitForTimeout(250)
  ok(/too short/.test(await errorText(page)) && (await layer(page).count()) === 1, 'a tap is too short, says so, and the map is still ready', await errorText(page))
  await drawWithMouse(page, Array.from({ length: 40 }, (_, i) => ({ x: mapBox.x + 200 + i * 6, y: mapBox.y + 300 })))
  ok(/too small or too flat/.test(await errorText(page)) && (await layer(page).count()) === 1, 'a straight line has no inside', await errorText(page))
  const cx = mapBox.x + 640
  const cy = mapBox.y + 260
  const bowtie = [
    ...Array.from({ length: 20 }, (_, i) => ({ x: cx - 100 + i * 10, y: cy - 80 + i * 8 })),
    ...Array.from({ length: 12 }, (_, i) => ({ x: cx + 100, y: cy + 80 - i * 14 })),
    ...Array.from({ length: 20 }, (_, i) => ({ x: cx + 100 - i * 10, y: cy - 80 + i * 8 })),
    ...Array.from({ length: 12 }, (_, i) => ({ x: cx - 100, y: cy + 80 - i * 14 })),
  ]
  await drawWithMouse(page, bowtie)
  ok(/crosses itself/.test(await errorText(page)) && (await page.locator('[data-draw="territory"]').count()) === 0, 'a figure-eight is refused as crossing itself', await errorText(page))
  ok((await page.getByTestId('freehand-error').getAttribute('role')) === 'alert', 'and announced to a screen reader')
  await drawAround(page, w, [-1, 0], ROWS)
  ok((await errorText(page)) === '' && (await count(page)).startsWith('6 leads inside'), 'the next good outline clears the message and counts', await count(page))
  await page.getByTestId('freehand-redraw').click()

  /* --- an overshoot is trimmed ---------------------------------------------------------------------------------- */
  await drawAround(page, w, [-1, 0], ROWS, { overshoot: 36 })
  ok((await count(page)).startsWith('6 leads inside'), 'a loop that runs past its start still counts the same six', await count(page))
  ok(/trimmed/.test(await text(page.locator('section p.text-xs').first())), 'and says the end was trimmed')
  await page.getByTestId('freehand-redraw').click()

  /* --- zoom buttons work while drawing ----------------------------------------------------------------------------- */
  const z0 = await pins(page)
  await page.getByRole('button', { name: 'Zoom in' }).click()
  await page.waitForTimeout(400)
  const z1 = await pins(page)
  const span = (ps) => Math.max(...ps.map((p) => p.x)) - Math.min(...ps.map((p) => p.x))
  ok(span(z1) > span(z0) * 1.5 && (await layer(page).count()) === 1, 'the zoom buttons still work with the drawing surface up', `${span(z0).toFixed(0)}px → ${span(z1).toFixed(0)}px`)
  await page.getByRole('button', { name: 'Zoom out' }).click()
  await page.waitForTimeout(400)

  /* --- the filters decide which leads count -------------------------------------------------------------------------- */
  await page.getByRole('button', { name: /^Contacted$/ }).click()
  await page.waitForTimeout(500)
  await drawAround(page, w, COLS, ROWS, { pad: 70 })
  const contacted = w.props.filter((p) => p.status === 'contacted').length
  ok((await count(page)).startsWith(`${contacted} leads inside`), 'drawn round everything with a status filter on, it counts only the filtered leads', `${await count(page)} (expect ${contacted})`)
  await page.getByRole('button', { name: /^All statuses$/ }).click()
  await page.waitForTimeout(500)
  ok((await count(page)).startsWith(`${w.props.length} leads inside`), 'and the count follows when the filter is cleared', await count(page))
  await page.getByPlaceholder(/Search address/).fill('100 Gate')
  await page.waitForTimeout(500)
  ok((await count(page)).startsWith('1 lead inside'), 'or a search narrows it', await count(page))
  await page.getByPlaceholder(/Search address/).fill('')
  await page.waitForTimeout(300)
  await page.getByTestId('freehand-redraw').click()

  /* --- afterwards the map is the map ---------------------------------------------------------------------------------- */
  await pinsTool.click()
  await page.waitForTimeout(300)
  const p0 = await pins(page)
  const mb = await page.locator('[data-tour="map-canvas"]').first().boundingBox()
  await page.mouse.move(mb.x + 400, mb.y + 400)
  await page.mouse.down()
  for (let i = 1; i <= 8; i++) await page.mouse.move(mb.x + 400 - i * 10, mb.y + 400 - i * 6)
  await page.mouse.up()
  await page.waitForTimeout(300)
  const p1 = await pins(page)
  ok(Math.abs(p1[0].x - p0[0].x + 80) < 3 && Math.abs(p1[0].y - p0[0].y + 48) < 3, 'dragging the map pans it again', `${(p1[0].x - p0[0].x).toFixed(0)}, ${(p1[0].y - p0[0].y).toFixed(0)}`)
  await page.mouse.click(p1[2].x, p1[2].y)
  await page.waitForTimeout(250)
  ok((await bulk(page)) === '1 selected', 'and a pin selects again')
  ok(w.calls.length === 0, 'through all of it, nothing was written', w.calls.join(', '))
  ok(errors.length === 0, 'no page errors', errors.join(' | '))
  await ctx.close()
}

/* =============================================================================== */
/* phone and iPad, with real touch events                                           */
/* =============================================================================== */
for (const [label, viewport] of [['phone (390×844)', { width: 390, height: 844 }], ['iPad (820×1180)', { width: 820, height: 1180 }], ['iPad landscape (1180×820)', { width: 1180, height: 820 }]]) {
  const w = makeWorld()
  const ctx = await browser.newContext({ viewport, isMobile: true, hasTouch: true, serviceWorkers: 'block' })
  const { page, errors } = await open(ctx, w)
  const cdp = await ctx.newCDPSession(page)
  const wide = viewport.width >= 800
  const tag = (s) => `${label}: ${s}`

  await page.getByTestId('map-tool-territory').tap()
  await page.waitForTimeout(300)
  const hint = page.getByTestId('freehand-hint')
  ok(await hint.isVisible(), tag('the instruction is showing'))
  const hb = await hint.boundingBox()
  const mb = await page.locator('[data-tour="map-canvas"]').first().boundingBox()
  ok(hb.x >= mb.x - 1 && hb.x + hb.width <= mb.x + mb.width + 1, tag('and fits inside the map'), `${Math.round(hb.width)}px in ${Math.round(mb.width)}px`)
  const tools = await page.getByTestId('map-tool-territory').boundingBox()
  ok(tools.height >= 40, tag('the tool buttons are a finger tall'), `${Math.round(tools.height)}px`)

  // Which pins are on screen: on a phone the grid is wider than the map, so use what shows.
  // A function, because the map moves when the bulk bar comes and goes — a ring
  // measured before the first selection is round the wrong place after it.
  const PAD = 40
  const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v))
  const measure = async () => {
    const mbNow = await page.locator('[data-tour="map-canvas"]').first().boundingBox()
    const view = (await pins(page)).filter((p) => p.x > mbNow.x + 20 && p.x < mbNow.x + mbNow.width - 20 && p.y > mbNow.y + 20 && p.y < mbNow.y + mbNow.height - 20)
    const midY = view.map((p) => p.y).sort((a, b) => a - b)[Math.floor(view.length / 2)]
    const pair = view.filter((p) => Math.abs(p.y - midY) < 20).sort((a, b) => a.x - b.x).slice(0, 2)
    // Round the pair, kept inside the map: on a phone the leads sit near the edge of
    // the screen and a ring that starts in the page gutter never reaches the layer.
    const box = pair.length === 2 && {
      x0: clamp(pair[0].x - PAD, mbNow.x + 8, pair[0].x - 14),
      y0: clamp(pair[0].y - PAD, mbNow.y + 8, pair[0].y - 14),
      x1: clamp(pair[1].x + PAD, pair[1].x + 14, mbNow.x + mbNow.width - 8),
      y1: clamp(pair[1].y + PAD, pair[1].y + 14, mbNow.y + mbNow.height - 8),
    }
    return { pair, box, mb: mbNow, inView: view.length }
  }
  let m = await measure()
  ok(m.pair.length === 2, tag('two leads are in view to draw round'), `${m.inView} in view`)
  let box = m.box
  let ring = loop(box, { step: 8 })

  // Two fingers is a pinch, not an outline. First, while the surface is clean — and
  // with a tally of what the layer actually received, so this cannot pass by the
  // touches having missed it.
  await page.evaluate(() => {
    const l = document.querySelector('[data-testid=freehand-layer]')
    window.__down = 0
    l.addEventListener('pointerdown', () => { window.__down++ })
  })
  await touchDraw(cdp, page, ring.slice(0, 30), { second: { x: m.mb.x + m.mb.width - 24, y: m.mb.y + 24 } })
  ok((await page.evaluate(() => window.__down)) >= 2, tag('the layer saw both fingers go down'), `${await page.evaluate(() => window.__down)}`)
  ok((await count(page)) === '' && (await errorText(page)) === '' && (await page.locator('[data-draw="territory"]').count()) === 0, tag('a second finger abandons the stroke, with no outline and no complaint'))
  const scrollBefore = await page.evaluate(() => [window.scrollX, window.scrollY, document.scrollingElement.scrollTop])
  const beforePins = await pins(page)
  await touchDraw(cdp, page, ring)
  const scrollAfter = await page.evaluate(() => [window.scrollX, window.scrollY, document.scrollingElement.scrollTop])
  const afterPins = await pins(page)
  ok(scrollAfter.join() === scrollBefore.join(), tag('a touch drag does not scroll the page'))
  const drift = Math.max(...beforePins.map((b) => Math.hypot(b.x - afterPins.find((a) => a.id === b.id).x, b.y - afterPins.find((a) => a.id === b.id).y)))
  ok(drift < 0.5, tag('or move the map'), `${drift.toFixed(2)}px`)
  const expect = afterPins.filter((p) => inside(p, ring)).map((p) => p.id).sort()
  ok(expect.length >= 2, tag('the stroke has leads inside'), expect.join())
  const got = await count(page)
  ok(got.startsWith(`${expect.length} lead${expect.length === 1 ? '' : 's'} inside`), tag('and the count is the number inside the line'), `${got} vs ${expect.length}`)
  const sel = page.getByTestId('freehand-apply')
  const sb = await sel.boundingBox()
  ok(sb.height >= 36 && sb.x >= 0 && sb.x + sb.width <= viewport.width, tag('with a Select button that fits the screen'), `${Math.round(sb.width)}×${Math.round(sb.height)}`)
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)
  ok(overflow <= 0, tag('and the page does not scroll sideways'), `${overflow}px`)
  await sel.tap()
  await page.waitForTimeout(300)
  ok((await bulk(page)) === `${expect.length} selected`, tag('tapping it selects exactly those'), await bulk(page))
  ok((await marked(page)).join() === expect.join(), tag('and they are the ones marked on the map'))

  // The bulk bar now stands above the map and has pushed it down the page. Bring it back into view.
  await page.locator('[data-tour="map-canvas"]').first().scrollIntoViewIfNeeded()
  await page.getByTestId('map-tool-territory').scrollIntoViewIfNeeded()
  await page.waitForTimeout(200)
  m = await measure()
  box = m.box
  ring = loop(box, { step: 8 })
  await touchDraw(cdp, page, ring)
  ok((await count(page)).startsWith(`${expect.length} lead`), tag('a one-finger stroke then draws normally, so nothing was left blocked'), await count(page))
  await page.getByTestId('freehand-cancel').tap()
  await page.waitForTimeout(250)

  // A tap with a finger.
  await page.getByTestId('map-tool-territory').tap()
  await page.waitForTimeout(200)
  await page.locator('[data-tour="map-canvas"]').first().scrollIntoViewIfNeeded()
  const mbTap = await page.locator('[data-tour="map-canvas"]').first().boundingBox()
  await touchDraw(cdp, page, [{ x: mbTap.x + 100, y: mbTap.y + 100 }])
  ok(/too short/.test(await errorText(page)), tag('a touch tap is too short'), await errorText(page))

  // Back to pins: touch panning returns.
  await page.getByTestId('map-tool-pins').tap()
  await page.waitForTimeout(250)
  ok((await layer(page).count()) === 0, tag('leaving drawing takes the surface away'))
  ok(errors.length === 0, tag('no page errors'), errors.join(' | '))
  void wide
  await ctx.close()
}

await browser.close()
console.log(fails.length ? `\n${fails.length} FAILED` : '\nAll checks passed')
process.exit(fails.length ? 1 : 0)
