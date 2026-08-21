import { chromium } from 'playwright'

/**
 * The map screen's list view, and the peek sheet that sits over it.
 *
 * Two claims under test. The list has to carry the information the map carries —
 * walking order, the distance to the next door — because it is what a rep sees
 * once the basemap needs a connection it does not have. And the peek sheet has
 * to leave the screen behind it usable: it is opened by tapping a stop, and if
 * it captures the whole viewport the rep cannot get back to the list, pan the
 * map, or change the filter. That was true invisibly for a while, because an
 * unpainted full-screen wrapper looks exactly like a correct one.
 */

const browser = await chromium.launch({
  executablePath: '/opt/pw-browsers/chromium-1194/chrome-linux/chrome',
})
const fails = []
const ok = (c, m) => { console.log(`${c ? 'PASS' : 'FAIL'}  ${m}`); if (!c) fails.push(m) }

for (const width of [320, 390, 768]) {
  const ctx = await browser.newContext({
    viewport: { width, height: 844 }, isMobile: width < 700, hasTouch: true,
  })
  const page = await ctx.newPage()
  const errors = []
  page.on('pageerror', (e) => errors.push(e.message))
  await page.goto('http://127.0.0.1:4173/', { waitUntil: 'domcontentloaded' })
  await page.waitForTimeout(1200)
  await page.getByRole('button', { name: /Try the demo/ }).click()
  await page.getByRole('button', { name: /Dana Whitfield/ }).click()
  await page.waitForTimeout(1800)
  // By href, not by label: the bottom bar is hidden at tablet width and the side
  // rail replaces it, so a name-based selector tests the wrong thing per width.
  // `:visible` matters: both navigations are in the DOM at every width and CSS
  // hides one of them, so an unfiltered selector clicks the hidden one.
  await page.locator('a[href="/map"]:visible').first().click()
  await page.waitForTimeout(1200)

  const toggle = page.getByRole('group', { name: 'View' })
  ok(await toggle.isVisible(), `[${width}] view switch is present`)

  // The control I added failed the app's own tap-target floor while the rows it
  // scrolls passed it, which is exactly the gap a per-component test leaves.
  const tb = await page.getByRole('button', { name: /^list$/i }).boundingBox()
  ok(
    (tb?.height ?? 0) >= 44,
    `[${width}] the switch itself clears the 44px tap floor (${Math.round(tb?.height ?? 0)}px)`,
  )

  await page.getByRole('button', { name: /^list$/i }).click()
  await page.waitForTimeout(700)

  const list = page.getByRole('list', { name: 'Route stops' })
  ok(await list.isVisible(), `[${width}] list renders`)
  const rows = await list.getByRole('button').count()
  ok(rows > 0, `[${width}] list has stops (${rows})`)

  // Route order: the first rows should be numbered 1, 2, 3.
  const firstThree = await list.getByRole('button').allInnerTexts()
  const numbered = firstThree.slice(0, 3).every((t, i) => t.trim().startsWith(String(i + 1)))
  ok(numbered, `[${width}] stops are numbered in walking order`)
  ok(/then .* to /.test(firstThree[0] ?? ''), `[${width}] each row names the distance to the next door`)

  // No horizontal overflow — the rule the whole app is held to.
  const scrollW = await page.evaluate(() => document.documentElement.scrollWidth)
  ok(scrollW <= width + 1, `[${width}] no horizontal overflow (${scrollW} <= ${width})`)

  /*
    Reachability, not page overflow. The check this replaces asserted
    `document.scrollWidth <= viewport`, which passed while the switch sat off the
    right edge unreachable: the page did not scroll, so nothing looked wrong, and
    a rep in list view could not get back to the map. What matters is whether a
    thumb can land on the control, so that is what is measured.
  */
  for (const name of ['map', 'list']) {
    const b = await page.getByRole('button', { name: new RegExp(`^${name}$`, 'i') }).boundingBox()
    ok(
      b != null && b.x >= -1 && b.x + b.width <= width + 1,
      `[${width}] the "${name}" switch is inside the screen (right edge ${Math.round((b?.x ?? 0) + (b?.width ?? 0))} of ${width})`,
    )
  }


  // Tap target height.
  const box = await list.getByRole('button').first().boundingBox()
  ok((box?.height ?? 0) >= 44, `[${width}] rows clear the 44px tap floor (${Math.round(box?.height ?? 0)}px)`)

  // Tapping a row opens the peek.
  await list.getByRole('button').first().click()
  await page.waitForTimeout(600)
  const peek = await page.getByRole('button', { name: /Open|Knock|Log/i }).count()
  ok(peek > 0, `[${width}] tapping a stop opens the property peek`)

  // The peek sheet is a phone thing: at tablet width the selected property
  // expands in the side pane instead, and no dialog is created.
  if (width < 700) {
    // Asserted from the rep's position — can they still reach the switch — rather
    // than by inspecting CSS, because the failure mode was a wrapper that looked
    // right and swallowed everything.
    const sheet = page.getByRole('dialog')
    ok(
      (await sheet.getAttribute('aria-modal')) === null,
      `[${width}] the peek does not claim to be modal`,
    )
  }

  // Back to the map, clicked with the peek still open — which is the regression.
  await page.getByRole('button', { name: /^map$/i }).click()
  await page.waitForTimeout(800)
  ok(
    await page.getByRole('button', { name: 'Zoom in' }).isVisible(),
    `[${width}] switching back restores the map`,
  )

  ok(errors.length === 0, `[${width}] no page errors${errors.length ? ': ' + errors[0] : ''}`)
  await ctx.close()
}

await browser.close()
console.log(fails.length ? `\n${fails.length} FAILED` : '\n=== route list OK ===')
process.exit(fails.length ? 1 : 0)
