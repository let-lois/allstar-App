import { chromium } from 'playwright'
import { chromiumPath } from './lib/browser.mjs'
import { dismissTour } from './lib/tour.mjs'

/**
 * Deleting a selection of leads from the console, safely.
 *
 * The server's half — admin only, tombstone first, exact counts — is pinned in
 * api/scripts/smoke-erase.mjs. This is the screen's half: that it takes two
 * deliberate taps and a reason, that Cancel and Escape post nothing, that a
 * second tap during a slow request starts nothing, that the request carries
 * exactly the ticked ids, that the rows and the pins leave on the tap rather
 * than on the next refresh, that a half-successful batch is reported as one,
 * that a refusal is worded as a refusal, and that a manager is not offered a
 * button the server would refuse.
 */

const BASE = process.env.BASE_URL || 'http://127.0.0.1:4173'
const browser = await chromium.launch({ executablePath: chromiumPath() })

const fails = []
const ok = (c, m, measured) => {
  console.log(`${c ? 'PASS' : 'FAIL'}  ${m}${measured ? `  (${measured})` : ''}`)
  if (!c) fails.push(m)
}
const json = (status, obj) => ({ status, contentType: 'application/json', body: JSON.stringify(obj) })
const text = (loc) => loc.innerText().then((t) => t.replace(/\s+/g, ' ').trim())

/* ---- the company's leads, and what the server would answer ------------------- */
function makeWorld(role = 'client_admin', count = 5) {
  const props = Array.from({ length: count }, (_, i) => ({
    id: `p${i + 1}`, address1: `${10 + i * 2} Cedar Bend Dr`, city: 'Round Rock', state: 'TX', zip: '78664',
    lat: 30.5115 + i * 0.0006, lng: -97.6755 + i * 0.0006,
    status: 'new', score: 60, assignedRepId: 'u_rep', contacts: [],
  }))
  return {
    role, props,
    erased: [],
    calls: [],
    // How the erase endpoint answers: 'ok' erases everything asked; 'partial'
    // fails the first id and reports the last as not found; 'forbidden' is 403.
    mode: 'ok',
    delayMs: 0,
  }
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
    r.fulfill(json(200, {
      user: meOf(w),
      properties: w.props.filter((p) => !w.erased.includes(p.id)),
      routes: [], appointments: [], tasks: [], activity: [], dailyStats: [], territories: [], erased: [...w.erased], serverTime: Date.now(),
    })),
  )
  await page.route('**/api/users', (r) => r.fulfill(json(200, { users: [{ id: 'u_rep', name: 'Marcus Vance', email: 'marcus@ridgeline.test', role: 'field_rep', active: true, pending: false, invitation: 'accepted', onboarding: 'complete', badge: 'active', createdAt: Date.now() }] })))
  await page.route('**/api/leads/erase-bulk', async (r) => {
    const body = JSON.parse(r.request().postData() || '{}')
    w.calls.push(body)
    if (w.delayMs) await new Promise((res) => setTimeout(res, w.delayMs))
    /*
      A selection larger than one request goes up as several, so the
      interesting failures are the ones that land on a *later* batch: by then
      leads really are gone, and what the screen says about them has to stay
      true. `breakOn` is the 1-based request to fail, `breakAs` how.
    */
    if (w.breakOn && w.calls.length === w.breakOn) {
      if (w.breakAs === 'forbidden') return r.fulfill(json(403, { error: 'Not permitted.' }))
      return r.abort('failed')
    }
    if (w.mode === 'forbidden') return r.fulfill(json(403, { error: 'Not permitted.' }))
    const ids = [...new Set(body.propertyIds ?? [])]
    if (w.mode === 'partial') {
      const [failed, ...rest] = ids
      const notFound = rest.pop()
      for (const id of rest) w.erased.push(id)
      return r.fulfill(json(200, { ok: true, requested: ids.length, deleted: rest.length, alreadyGone: 0, notFound: notFound ? [notFound] : [], failed: failed ? [failed] : [], photos: 0 }))
    }
    for (const id of ids) w.erased.push(id)
    return r.fulfill(json(200, { ok: true, requested: ids.length, deleted: ids.length, alreadyGone: 0, notFound: [], failed: [], photos: 0 }))
  })
  await page.route(/maps\.googleapis\.com/, (r) => r.abort())
}

async function signIn(page, email) {
  await page.goto(BASE, { waitUntil: 'domcontentloaded' })
  await page.waitForTimeout(900)
  await page.locator('input[type="email"]').first().fill(email)
  await page.locator('input[autocomplete="current-password"]').fill('a-real-password')
  await page.getByRole('button', { name: /^Sign in$/ }).click()
  await page.waitForTimeout(1600)
  await dismissTour(page)
}
const desktop = () => browser.newContext({ viewport: { width: 1280, height: 900 }, serviceWorkers: 'block' })
// DataList renders phone cards and the desktop table both, and hides one by
// breakpoint — so the row checkboxes exist twice, and only the table's are
// laid out here. Scoped to the table, or the first match is a 0x0 box.
const rowBoxes = (page) => page.locator('tbody tr input[type="checkbox"]')
const headerBox = (page) => page.locator('thead input[type="checkbox"]')
const rows = (page) => page.locator('tbody tr')

/* ========================================================================== */
/* An admin deletes three of five: two taps, a reason, an exact answer          */
/* ========================================================================== */
{
  const w = makeWorld()
  const ctx = await desktop()
  const page = await ctx.newPage()
  const errors = []
  page.on('pageerror', (e) => errors.push(e.message))
  await mockApi(page, w)
  await signIn(page, 'nadia@ridgeline.test')
  await page.goto(`${BASE}/admin/leads`, { waitUntil: 'domcontentloaded' })
  await page.waitForTimeout(1500)
  ok((await rows(page).count()) === 5, 'five leads are listed', `${await rows(page).count()}`)
  ok((await page.getByTestId('bulk-delete').count()) === 0, 'with nothing selected there is no delete button anywhere on the page')

  for (const i of [0, 1, 2]) await rowBoxes(page).nth(i).check()
  await page.waitForTimeout(300)
  ok((await text(page.getByTestId('bulk-count'))) === '3 selected', 'the bar counts the selection', await text(page.getByTestId('bulk-count')))
  const del = page.getByTestId('bulk-delete')
  ok((await del.count()) === 1 && /Delete selected/.test(await del.innerText()), 'and offers Delete selected beside the existing actions')
  ok((await rows(page).count()) === 5 && w.calls.length === 0, 'ticking rows deleted nothing')

  /* --- the dialog ------------------------------------------------------------- */
  await del.click()
  await page.waitForTimeout(400)
  const dlg = page.getByTestId('bulk-delete-dialog')
  const opened = (await dlg.count()) === 1
  // Stated as a failure and the section abandoned, not a thirty-second wait on
  // a locator: a button that deletes on the first tap is the exact bug this
  // gate exists for, and it must read as FAIL, never as a crash.
  ok(opened && (await dlg.getAttribute('role')) === 'alertdialog', 'the button opens a dialog rather than deleting', opened ? await dlg.getAttribute('role') : `no dialog; ${w.calls.length} request(s) sent, ${await rows(page).count()} rows left`)
  if (!opened) {
    ok(w.calls.length === 0 && (await rows(page).count()) === 5, 'and nothing was deleted by the first tap', `${w.calls.length} request(s), ${await rows(page).count()} rows`)
    await ctx.close()
  } else {
  ok(/^Delete 3 leads\?/.test(await text(dlg.locator('h2'))), 'titled with the count, plural', await text(dlg.locator('h2')))
  ok(/permanently/.test(await text(dlg)) && /cannot be undone/.test(await text(dlg)) && /map/.test(await text(dlg)), 'and it says what will happen: permanent, gone from the map, no undo')
  const confirm = dlg.getByTestId('bulk-delete-dialog-confirm')
  ok((await confirm.innerText()).trim() === 'Delete 3 leads', 'the destructive button names the count too', await confirm.innerText())
  ok(await confirm.isDisabled(), 'and is disabled until a reason is given — the server requires one, so the screen does too')
  ok(await page.evaluate(() => document.activeElement?.getAttribute('data-testid')) === 'bulk-delete-dialog-cancel', 'focus lands on Cancel, so Enter cannot be the second tap', await page.evaluate(() => document.activeElement?.getAttribute('data-testid')))

  /* --- cancel, twice over ----------------------------------------------------- */
  await dlg.getByTestId('bulk-delete-dialog-cancel').click()
  await page.waitForTimeout(300)
  ok((await dlg.count()) === 0 && w.calls.length === 0 && (await rows(page).count()) === 5, 'Cancel closes it, posts nothing, and every row is still there')
  ok((await text(page.getByTestId('bulk-count'))) === '3 selected', 'and the selection is kept — cancelling a delete should not cost the ticks')
  await del.click()
  await page.waitForTimeout(300)
  await page.keyboard.press('Escape')
  await page.waitForTimeout(300)
  ok((await dlg.count()) === 0 && w.calls.length === 0, 'so does Escape')

  /* --- confirm, with a slow server ------------------------------------------- */
  await del.click()
  await page.waitForTimeout(300)
  await dlg.getByTestId('bulk-delete-reason').fill('Sc')
  ok(await confirm.isDisabled(), 'two characters of reason is not a reason')
  await dlg.getByTestId('bulk-delete-reason').fill('Scrubbed list came back')
  ok(!(await confirm.isDisabled()), 'a real one enables the button')
  w.delayMs = 1200
  await confirm.click()
  await page.waitForTimeout(250)
  ok((await dlg.getAttribute('data-busy')) === 'true' && /Deleting leads…/.test(await confirm.innerText()), 'while the server works the dialog reads as busy', await confirm.innerText())
  ok((await confirm.isDisabled()) && (await dlg.getByTestId('bulk-delete-dialog-cancel').isDisabled()), 'and both buttons are disabled')
  await confirm.click({ force: true }).catch(() => {})
  await page.keyboard.press('Escape')
  await page.waitForTimeout(1500)
  ok(w.calls.length === 1, 'a second tap and an Escape during the request started nothing — exactly one request', `${w.calls.length}`)
  const sent = w.calls[0]
  ok(Array.isArray(sent.propertyIds) && sent.propertyIds.length === 3 && ['p1', 'p2', 'p3'].every((id) => sent.propertyIds.includes(id)), 'carrying exactly the three ticked ids', JSON.stringify(sent.propertyIds))
  ok(sent.reason === 'Scrubbed list came back', 'and the reason')

  /* --- afterwards ------------------------------------------------------------- */
  ok((await dlg.count()) === 0, 'the dialog closes')
  ok((await rows(page).count()) === 2, 'the three rows are gone', `${await rows(page).count()}`)
  ok(/^3 leads deleted\.$/.test(await text(page.getByRole('status').first()).catch(() => '')) || /3 leads deleted\./.test(await text(page.locator('body'))), 'and the page says so, with the count')
  ok((await page.getByTestId('bulk-count').count()) === 0, 'the selection is cleared and the bar is gone')
  ok(/2 in total/.test(await text(page.locator('body'))), 'the total in the heading follows', (await text(page.locator('body'))).match(/\d+ in total/)?.[0])
  await page.getByRole('group', { name: 'View' }).getByRole('button', { name: /map/i }).click()
  await page.waitForTimeout(1500)
  const pins = await page.locator('[data-marker="pin"]').count()
  ok(pins === 2, 'the map shows two pins — the deleted leads’ pins went with them', `${pins} pins`)
  await page.reload({ waitUntil: 'domcontentloaded' })
  await page.waitForTimeout(1800)
  ok((await rows(page).count()) === 2 || (await page.locator('[data-marker="pin"]').count()) === 2, 'and after a reload they stay gone — nothing cached brings them back')
  ok(errors.length === 0, 'no page errors', errors.join(' | '))
  await ctx.close()
  }
}

/* ========================================================================== */
/* One lead reads in the singular; select-all is only what is on screen          */
/* ========================================================================== */
{
  const w = makeWorld()
  const ctx = await desktop()
  const page = await ctx.newPage()
  await mockApi(page, w)
  await signIn(page, 'nadia@ridgeline.test')
  await page.goto(`${BASE}/admin/leads`, { waitUntil: 'domcontentloaded' })
  await page.waitForTimeout(1500)
  await rowBoxes(page).nth(4).check()
  await page.waitForTimeout(200)
  await page.getByTestId('bulk-delete').click()
  await page.waitForTimeout(300)
  const dlg = page.getByTestId('bulk-delete-dialog')
  ok(/^Delete 1 lead\?/.test(await text(dlg.locator('h2'))) && (await dlg.getByTestId('bulk-delete-dialog-confirm').innerText()).trim() === 'Delete 1 lead', 'one lead reads in the singular, title and button', await text(dlg.locator('h2')))
  await dlg.getByTestId('bulk-delete-dialog-cancel').click()
  await page.getByTestId('bulk-clear').click()
  await page.waitForTimeout(200)
  ok((await page.getByTestId('bulk-count').count()) === 0, 'Clear selection empties it')

  await page.locator('input[type="search"]').fill('12 Cedar')
  await page.waitForTimeout(400)
  ok((await rows(page).count()) === 1, 'a search narrows the list to one')
  await headerBox(page).check()
  await page.waitForTimeout(200)
  ok((await text(page.getByTestId('bulk-count'))) === '1 selected', 'Select everything shown selects the one that is shown, not the five that exist', await text(page.getByTestId('bulk-count')))
  await headerBox(page).uncheck()
  await page.waitForTimeout(200)
  ok((await page.getByTestId('bulk-count').count()) === 0, 'and unticking it deselects them')
  await page.locator('input[type="search"]').fill('')
  await page.waitForTimeout(400)
  await headerBox(page).check()
  await page.waitForTimeout(200)
  ok((await text(page.getByTestId('bulk-count'))) === '5 selected', 'with no filter it is all five, which are all on screen')
  await ctx.close()
}

/* ========================================================================== */
/* A half-successful batch is reported as one; a refusal is worded as one      */
/* ========================================================================== */
{
  const w = makeWorld()
  w.mode = 'partial'
  const ctx = await desktop()
  const page = await ctx.newPage()
  await mockApi(page, w)
  await signIn(page, 'nadia@ridgeline.test')
  await page.goto(`${BASE}/admin/leads`, { waitUntil: 'domcontentloaded' })
  await page.waitForTimeout(1500)
  for (const i of [0, 1, 2, 3]) await rowBoxes(page).nth(i).check()
  await page.getByTestId('bulk-delete').click()
  await page.waitForTimeout(300)
  const dlg = page.getByTestId('bulk-delete-dialog')
  await dlg.getByTestId('bulk-delete-reason').fill('Testing a failure')
  await dlg.getByTestId('bulk-delete-dialog-confirm').click()
  await page.waitForTimeout(900)
  const body = await text(page.locator('body'))
  ok(/2 leads deleted/.test(body) && /1 could not be deleted/.test(body) && /1 no longer exists on this team/.test(body), 'the notice says exactly what happened: two deleted, one failed, one already gone from the team', body.match(/\d+ leads? deleted[^.]*\.[^.]*\.[^.]*\./)?.[0])
  ok((await rows(page).count()) === 3, 'the two that were deleted are gone; the one that failed and the one never ticked stay', `${await rows(page).count()}`)
  ok((await rows(page).filter({ hasText: '10 Cedar Bend Dr' }).count()) === 1, 'and the failed one is the one still there — nothing was hidden that the server did not confirm gone')

  w.mode = 'forbidden'
  await rowBoxes(page).nth(0).check()
  await page.getByTestId('bulk-delete').click()
  await page.waitForTimeout(300)
  await dlg.getByTestId('bulk-delete-reason').fill('Should be refused')
  await dlg.getByTestId('bulk-delete-dialog-confirm').click()
  await page.waitForTimeout(700)
  ok((await dlg.count()) === 1 && /do not have permission to delete leads/.test(await text(dlg.getByTestId('bulk-delete-error'))), 'a 403 is worded as a permission problem, in the dialog, which stays open', await text(dlg.getByTestId('bulk-delete-error')))
  ok((await rows(page).count()) === 3, 'and nothing left the screen on a refusal')
  await ctx.close()
}

/* ========================================================================== */
/* A manager can reassign and set status, and is not offered Delete            */
/* ========================================================================== */
{
  const w = makeWorld('manager')
  const ctx = await desktop()
  const page = await ctx.newPage()
  await mockApi(page, w)
  await signIn(page, 'priya@ridgeline.test')
  await page.goto(`${BASE}/admin/leads`, { waitUntil: 'domcontentloaded' })
  await page.waitForTimeout(1500)
  await rowBoxes(page).nth(0).check()
  await rowBoxes(page).nth(1).check()
  await page.waitForTimeout(200)
  ok((await text(page.getByTestId('bulk-count'))) === '2 selected' && (await page.getByLabel('Reassign to').count()) === 1, 'a manager still gets the bar, with reassignment')
  ok((await page.getByTestId('bulk-delete').count()) === 0, 'and no Delete selected — the server would refuse it, so the screen does not offer it')
  await ctx.close()
}

/* ========================================================================== */
/* More leads than fit in one request: batched, counted, reported once          */
/* ========================================================================== */
{
  const w = makeWorld('client_admin', 60)
  const ctx = await desktop()
  const page = await ctx.newPage()
  const errors = []
  page.on('pageerror', (e) => errors.push(e.message))
  await mockApi(page, w)
  await signIn(page, 'nadia@ridgeline.test')
  await page.goto(`${BASE}/admin/leads`, { waitUntil: 'domcontentloaded' })
  await page.waitForTimeout(1600)
  ok((await rows(page).count()) === 60, 'sixty leads are listed', `${await rows(page).count()}`)
  await headerBox(page).check()
  await page.waitForTimeout(400)
  ok((await text(page.getByTestId('bulk-count'))) === '60 selected', 'all sixty are selected', await text(page.getByTestId('bulk-count')))
  await page.getByTestId('bulk-delete').click()
  await page.waitForTimeout(400)
  const dlg = page.getByTestId('bulk-delete-dialog')
  await dlg.getByTestId('bulk-delete-reason').fill('Pilot data, finished with')
  await dlg.getByTestId('bulk-delete-dialog-confirm').click()
  await page.waitForTimeout(3000)

  ok(w.calls.length === 3, 'sixty leads go up as three requests, not one', `${w.calls.length} requests`)
  ok(w.calls.every((c) => c.propertyIds.length <= 25), 'and no request carries more than twenty-five', w.calls.map((c) => c.propertyIds.length).join(' + '))
  const sent = w.calls.flatMap((c) => c.propertyIds)
  ok(sent.length === 60 && new Set(sent).size === 60, 'every lead is sent exactly once across the batches', `${sent.length} sent, ${new Set(sent).size} distinct`)
  ok(w.calls.every((c) => c.reason === 'Pilot data, finished with'), 'each batch carries the same reason')
  ok(/60 leads deleted/.test(await text(page.locator('body'))), 'the screen reports one total, not three', (await text(page.locator('body'))).match(/\d+ leads deleted[^.]*/)?.[0])
  ok((await dlg.count()) === 0, 'and the dialog closes')
  ok(errors.length === 0, 'no page errors', errors.join(' | '))
  await ctx.close()
}

/* ========================================================================== */
/* A batch that never comes back: what is known is said, and nothing more      */
/* ========================================================================== */
{
  /*
    The sentence this replaces was "Nothing was deleted", said on any failure
    the client could not read. It was not the screen's to say: the server
    destroys one lead at a time and commits each before the next, so a request
    that never answers may have done all of its work, some, or none — and by
    the second batch, twenty-five leads are provably gone already.
  */
  const w = makeWorld('client_admin', 60)
  w.breakOn = 2
  w.breakAs = 'dead'
  const ctx = await desktop()
  const page = await ctx.newPage()
  await mockApi(page, w)
  await signIn(page, 'nadia@ridgeline.test')
  await page.goto(`${BASE}/admin/leads`, { waitUntil: 'domcontentloaded' })
  await page.waitForTimeout(1600)
  await headerBox(page).check()
  await page.waitForTimeout(400)
  await page.getByTestId('bulk-delete').click()
  await page.waitForTimeout(400)
  const dlg = page.getByTestId('bulk-delete-dialog')
  await dlg.getByTestId('bulk-delete-reason').fill('Pilot data, finished with')
  await dlg.getByTestId('bulk-delete-dialog-confirm').click()
  await page.waitForTimeout(3000)

  const errBox = dlg.getByTestId('bulk-delete-error')
  ok((await errBox.count()) === 1, 'the break is reported in the dialog rather than swallowed')
  const said = (await errBox.count()) ? await text(errBox) : '(nothing reported)'
  ok(!/Nothing was deleted/i.test(said), 'the screen does not claim nothing was deleted — twenty-five already had been', said)
  ok(/25 leads had already been deleted/.test(said), 'it says how many are confirmed gone', said)
  ok(/may or may not/.test(said) && /refresh/i.test(said), 'and that the batch in flight is unknown, with what to do about it', said)
  ok((await dlg.count()) === 1, 'the dialog stays open, holding the reason that was typed')
  ok(w.calls.length === 2, 'and it stopped rather than carrying on into the rest', `${w.calls.length} requests`)
  await ctx.close()
}

/* ========================================================================== */
/* A batch the server refuses: definite, so it is worded definitely            */
/* ========================================================================== */
{
  const w = makeWorld('client_admin', 60)
  w.breakOn = 2
  w.breakAs = 'forbidden'
  const ctx = await desktop()
  const page = await ctx.newPage()
  await mockApi(page, w)
  await signIn(page, 'nadia@ridgeline.test')
  await page.goto(`${BASE}/admin/leads`, { waitUntil: 'domcontentloaded' })
  await page.waitForTimeout(1600)
  await headerBox(page).check()
  await page.waitForTimeout(400)
  await page.getByTestId('bulk-delete').click()
  await page.waitForTimeout(400)
  const dlg = page.getByTestId('bulk-delete-dialog')
  await dlg.getByTestId('bulk-delete-reason').fill('Pilot data, finished with')
  await dlg.getByTestId('bulk-delete-dialog-confirm').click()
  await page.waitForTimeout(3000)

  const errBox = dlg.getByTestId('bulk-delete-error')
  ok((await errBox.count()) === 1, 'the refusal is reported in the dialog')
  const said = (await errBox.count()) ? await text(errBox) : '(nothing reported)'
  ok(/permission/i.test(said), 'a refusal is worded as a refusal', said)
  ok(/were not deleted/.test(said) && !/may or may not/.test(said), 'and because the server answered, the rest is stated rather than guessed', said)
  await ctx.close()
}

await browser.close()
if (fails.length) {
  console.log(`\n${fails.length} FAILED`)
  process.exit(1)
}
console.log('\n=== deleting a selection takes two taps and a reason, and reports exactly what happened ===')
