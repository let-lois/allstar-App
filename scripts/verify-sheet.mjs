import { chromium } from 'playwright'
import { chromiumPath } from './lib/browser.mjs'
import { dismissTour } from './lib/tour.mjs'

/**
 * The scrim, and the click it must not eat.
 *
 * A sheet opens because someone clicked a control, and the scrim then covers
 * that exact spot. So the very next click — a double-click, or a second click
 * from someone who thought the first had not registered — lands on a dismiss
 * button that did not exist when they started clicking. The sheet appears and
 * vanishes, with the scrim's fade as a flash across the screen, and nothing
 * anywhere reports a problem.
 *
 * Reported from the console's Team screen as "it pops up for a moment and then
 * I can't see that panel". Fixed in `BottomSheet` rather than at that call site,
 * because every scrimmed sheet in the app opens from a control underneath it.
 *
 * What is asserted here is both halves: that the accidental dismissal no longer
 * happens, and that a *deliberate* one still does. A guard that made the scrim
 * stop closing sheets would pass the first assertion on its own and would be a
 * worse bug than the one it replaced — a modal a person cannot get out of.
 *
 * Driven in the demo, on the map's property sheet as well as the console's, so
 * it needs no account. The scrim is the same component in both.
 */

const BASE = process.env.BASE_URL || 'http://127.0.0.1:4173'

const browser = await chromium.launch({ executablePath: chromiumPath() })

const fails = []
const ok = (c, m) => {
  console.log(`${c ? 'PASS' : 'FAIL'}  ${m}`)
  if (!c) fails.push(m)
}

const ctx = await browser.newContext({
  viewport: { width: 1280, height: 900 },
  serviceWorkers: 'block',
})
const page = await ctx.newPage()
const pageErrors = []
page.on('pageerror', (e) => pageErrors.push(e.message))

await page.goto(BASE, { waitUntil: 'domcontentloaded' })
await page.waitForTimeout(1200)
await page.getByRole('button', { name: /Try the demo/ }).click()
await page.getByRole('button', { name: /Nadia Petrov/ }).click()
await dismissTour(page)
await page.waitForTimeout(1600)

await page.goto(`${BASE}/admin/team`, { waitUntil: 'domcontentloaded' })
await page.waitForTimeout(2000)

const open = async () => (await page.locator('[role="dialog"]').count()) > 0
const manage = () => page.getByRole('button', { name: /^Manage$/ }).first()

/* --- the bug ------------------------------------------------------------- */
await manage().dblclick()
await page.waitForTimeout(900)
ok(await open(), 'double-clicking a control that opens a sheet leaves the sheet open')

// The panel is the point, not just the wrapper: a dialog element with nothing
// in it would satisfy the check above and be the same bug on screen.
ok(
  (await page.locator('[role="dialog"]').innerText()).trim().length > 40,
  'and the panel it opened is on screen with its contents',
)

/* --- the other half ------------------------------------------------------ */
//
// Past the grace window, a click that starts and ends on the scrim is a person
// asking to leave. Aimed at the top of the screen, well clear of the panel.
await page.waitForTimeout(600)
await page.mouse.click(640, 40)
await page.waitForTimeout(600)
ok(!(await open()), 'a deliberate click on the scrim still dismisses it')

/* --- and the keyboard ---------------------------------------------------- */
await manage().click()
await page.waitForTimeout(800)
ok(await open(), 'it reopens')
await page.keyboard.press('Escape')
await page.waitForTimeout(500)
ok(!(await open()), 'Escape still dismisses it')

/* --- a press that began inside the panel --------------------------------- */
//
// Select text in the sheet and release past its edge. The click that produces
// lands on the scrim having started somewhere that meant the opposite, and
// closing on it loses whatever the person was in the middle of.
await manage().click()
await page.waitForTimeout(900)
const panel = await page.locator('.anim-sheet').boundingBox()
await page.mouse.move(panel.x + 200, panel.y + 120)
await page.mouse.down()
await page.mouse.move(panel.x + 400, panel.y - 80, { steps: 8 })
await page.mouse.up()
await page.waitForTimeout(500)
ok(await open(), 'a drag that starts in the panel and ends on the scrim does not dismiss it')

ok(pageErrors.length === 0, `no page errors${pageErrors.length ? `: ${pageErrors[0]}` : ''}`)

await browser.close()

if (fails.length) {
  console.log(`\n${fails.length} FAILED`)
  process.exit(1)
}
console.log('\n=== sheet dismissal OK ===')
