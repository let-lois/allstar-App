import { readFileSync } from 'node:fs'
import { chromium } from 'playwright'
import { chromiumPath } from './lib/browser.mjs'
import { dismissTour } from './lib/tour.mjs'
import { GEOCODE_PROVIDERS, findProvider, isSelectable } from '../api/src/geocode-providers.ts'
import { describeSpend, estimateLookupSpend } from '../src/lib/spend.ts'

/**
 * Companies bringing their own geocoding provider.
 *
 * Two halves, because two different things can be wrong.
 *
 * The registry half runs no browser. What can be wrong there is arithmetic on
 * data: a duplicate id, a provider offered with no adapter behind it, a vendor
 * whose storage terms are not stated. It imports the Worker's own registry
 * rather than a copy, so a gate cannot pass against a description of the
 * registry that has drifted from the registry.
 *
 * The screen half drives a browser against a mocked API. What can be wrong
 * there is the thing this feature exists to prevent: an operator being told
 * they are connected to something that will never be called, or a customer's
 * API key appearing on a screen. The API is mocked rather than pointed at a
 * live Worker so a failure here means the client mishandled a response and
 * nothing else.
 */

const BASE = process.env.BASE_URL || 'http://127.0.0.1:4173'

const fails = []
const ok = (cond, msg, measured) => {
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${msg}${measured ? `  (${measured})` : ''}`)
  if (!cond) fails.push(msg)
}

/* ========== 1. the registry ============================================= */
{
  ok(GEOCODE_PROVIDERS.length >= 10, `the catalogue offers a real choice (${GEOCODE_PROVIDERS.length} providers)`)

  const ids = GEOCODE_PROVIDERS.map((p) => p.id)
  ok(new Set(ids).size === ids.length, 'no two providers share an id')

  // Census is the floor. Without a keyless provider a new company cannot
  // geocode anything until somebody opens an account with a vendor, which
  // would make the first import fail on the day they signed up.
  const keyless = GEOCODE_PROVIDERS.filter((p) => !p.needsKey)
  ok(keyless.length >= 1, `at least one provider needs no account (${keyless.map((p) => p.id).join(', ') || 'none'})`)
  ok(
    keyless.every((p) => p.adapter === 'live'),
    'and every keyless provider can actually be called',
  )

  // The whole point of the screen. A provider whose storage terms are blank
  // would be offered to a customer with nothing said about whether they may
  // keep what they pay for.
  const silent = GEOCODE_PROVIDERS.filter((p) => !p.storageNote || !p.storage)
  ok(silent.length === 0, `every provider states its storage terms${silent.length ? ` — missing: ${silent.map((p) => p.id).join(', ')}` : ''}`)

  // Google and Radar both cap caching at ~30 days, which is in direct conflict
  // with storing coordinates for the life of a lead. If either is ever marked
  // 'permanent' the screen starts telling customers the opposite of the truth.
  for (const id of ['google', 'radar']) {
    const p = findProvider(id)
    if (!p) throw new Error(`${id} is no longer in the registry — update this gate`)
    ok(p.storage === 'temporary', `${p.label} is still marked as temporary-storage-only`)
  }

  // The refusal that keeps the screen honest.
  const planned = GEOCODE_PROVIDERS.filter((p) => p.adapter === 'planned')
  ok(planned.length > 0, 'the registry knows about providers it cannot yet call')
  ok(
    planned.every((p) => !isSelectable(p.id)),
    'and none of them can be selected',
  )
  const live = GEOCODE_PROVIDERS.filter((p) => p.adapter === 'live')
  ok(live.length > 0 && live.every((p) => isSelectable(p.id)), `every live provider can be selected (${live.map((p) => p.id).join(', ')})`)
}

/* ========== 1a. the picker is actually wired to the geocoder ============ */
{
  /*
    The gap this check exists for shipped once, and nothing caught it.

    `activeGeocoderFor` was written, exported, covered by the screen, described
    in the README — and never called. A company could save a key, select a
    provider, be told on screen they would be billed for it, and every import
    still ran on the deployment's own keys. A feature that is entirely present
    except for being connected, which no amount of testing the parts detects.

    So this reads the endpoint that spends the money and insists it goes through
    the two functions that make the picker real. Structural rather than
    behavioural because the alternative needs a live Worker and a real vendor
    key — `cd api && npm run smoke:deadkey` is now exactly that, driving this
    endpoint against a stand-in vendor, so this is the cheap first line rather
    than the only one.
  */
  const src = readFileSync(new URL('../api/src/index.ts', import.meta.url), 'utf8')
  const i = src.indexOf("path === '/api/import/geocode'")
  if (i < 0) throw new Error('the geocode endpoint moved — update this gate')
  /*
    Bounded by where the next route begins, not by a character count.

    It was `i + 2000`, chosen to be "far enough to contain it, short enough not
    to pick up a mention from the next route along" — and then the handler grew
    past 2000 characters and `recordLookups` fell out of the window. The gate
    went red on a call that was still there, which is the worst way for a gate
    to fail: it accuses working code, and the obvious response is to widen the
    number and wait for it to happen again.

    Both ends are now derived. The handler is whatever sits between this route
    and the next one, however long it gets.
  */
  const next = src.indexOf("path === '", i + 30)
  if (next < 0) throw new Error('cannot find the route after /api/import/geocode — update this gate')
  const handler = src.slice(i, next)

  ok(
    /geocodeKeysFor\(/.test(handler),
    'the geocode endpoint asks which provider this company chose',
  )
  ok(
    /recordLookups\(/.test(handler),
    'and records what it sent, so the next estimate knows what is left',
  )
  ok(
    !/env\.GOOGLE_MAPS_API_KEY/.test(handler),
    'and does not reach past that to the deployment’s own key',
  )
}

/* ========== 1b. the price a company will actually be charged =========== */
{
  /*
    The display string and the number have to agree.

    Two copies of a price exist on purpose — prose for the row a human reads,
    a number for the arithmetic that warns them before an import spends money.
    Parsing the prose to do the maths would have been worse, so instead the two
    are checked against each other here. Drift between them is a screen that
    quotes one figure and bills against another.
  */
  for (const p of GEOCODE_PROVIDERS) {
    const quoted = [...p.price.matchAll(/\$([0-9]+(?:\.[0-9]+)?)/g)].map((m) => Number(m[1]))
    if (quoted.length === 0) {
      ok(p.pricePerThousandUsd === null, `${p.label} quotes no price and carries no number ("${p.price}")`)
    } else {
      // A range takes its top, so an estimate is never cheaper than the bill.
      const top = Math.max(...quoted)
      ok(
        p.pricePerThousandUsd === top,
        `${p.label}'s number matches its price line (${p.pricePerThousandUsd} vs "${p.price}")`,
      )
    }

    const allowance = p.free.match(/([0-9][0-9,]*)\s*per\s*(day|month)/i)
    if (allowance) {
      const n = Number(allowance[1].replace(/,/g, ''))
      ok(
        p.freeCount === n && p.freePeriod === allowance[2].toLowerCase(),
        `${p.label}'s free allowance matches its free line (${p.freeCount}/${p.freePeriod} vs "${p.free}")`,
      )
    } else {
      ok(p.freeCount === null, `${p.label} states no countable allowance and carries none ("${p.free}")`)
    }
  }
}

/* ========== 1c. the estimate itself ==================================== */
{
  const google = findProvider('google')
  const geocodio = findProvider('geocodio')
  const here = findProvider('here')
  const census = findProvider('census')

  // Census bills nobody, so the screen stays silent. That silence is what makes
  // the warning mean something when it does appear.
  ok(estimateLookupSpend(census, 50_000).kind === 'free', 'Census is free at any size')
  ok(describeSpend(estimateLookupSpend(census, 50_000)) === null, 'and says nothing at all')
  ok(estimateLookupSpend(null, 900).kind === 'free', 'no configured provider is treated as free')

  // Inside the allowance is still worth saying — it names what is being spent.
  const small = estimateLookupSpend(google, 5_000)
  ok(small.kind === 'within-allowance', '5,000 lookups sit inside Google’s 10,000/month')
  ok(/free/i.test(describeSpend(small)?.text ?? ''), 'and the wording says so')

  // The number that matters: 50,000 leads, minus 10,000 free, at $5/1,000.
  const big = estimateLookupSpend(google, 50_000)
  ok(big.kind === 'billable', '50,000 lookups on Google is billable')
  ok(big.kind === 'billable' && big.billableLookups === 40_000, 'the free allowance is deducted first')
  ok(big.kind === 'billable' && big.estimateUsd === 200, `and the estimate is $200 (got ${big.estimateUsd})`)

  const gc = estimateLookupSpend(geocodio, 4_000)
  ok(gc.kind === 'billable' && gc.estimateUsd === 1.5, `Geocodio: 4,000 lookups is $1.50 (got ${gc.estimateUsd})`)

  // Rounded up, always. $1.234 is reported as $1.24 — the one direction this
  // must never be wrong in is cheap, because cheap is what causes the surprise.
  const odd = estimateLookupSpend(geocodio, 3_734)
  const exact = ((3_734 - 2_500) / 1000) * 1.0
  ok(
    odd.kind === 'billable' && odd.estimateUsd >= exact,
    `an estimate never reads below the true cost (${odd.kind === 'billable' ? odd.estimateUsd : '?'} vs ${exact})`,
  )
  ok(odd.kind === 'billable' && odd.estimateUsd === 1.24, `and rounds up to the cent (got ${odd.kind === 'billable' ? odd.estimateUsd : '?'})`)

  /*
    Accumulation — the case the counter exists for.

    Three 1,000-address imports on Geocodio are each well inside the 2,500/day
    allowance when priced against a fresh one, so without usage every single
    batch reads as free and the day quietly crosses the cap. With 2,400 already
    sent, the fourth 1,000 has to come back billable.
  */
  const fresh = estimateLookupSpend(geocodio, 1_000)
  ok(fresh.kind === 'within-allowance', 'a small batch on an untouched allowance is free')

  const late = estimateLookupSpend(geocodio, 1_000, { today: 2_400, month: 2_400 })
  ok(late.kind === 'billable', 'the same batch is billable once 2,400 have already gone')
  ok(
    late.kind === 'billable' && late.billableLookups === 900,
    `and only the part past the remaining 100 is charged (got ${late.kind === 'billable' ? late.billableLookups : '?'})`,
  )
  ok(
    /already/.test(describeSpend(late)?.text ?? ''),
    'and the wording says some of the allowance is already gone',
  )

  // Daily and monthly allowances must read the right field. Google's is monthly,
  // so a day's usage must not be what is subtracted from it.
  const monthly = estimateLookupSpend(google, 1_000, { today: 9_900, month: 200 })
  ok(
    monthly.kind === 'within-allowance',
    'a monthly allowance is measured against the month, not the day',
  )
  const daily = estimateLookupSpend(geocodio, 200, { today: 2_450, month: 40_000 })
  ok(
    daily.kind === 'billable',
    'and a daily allowance against the day, not the month',
  )

  // Missing usage must never read as "plenty left" — it reads as a fresh
  // allowance, which is the same as the old behaviour and no worse.
  ok(
    estimateLookupSpend(geocodio, 1_000, null).kind === 'within-allowance',
    'unknown usage falls back to a fresh allowance rather than throwing',
  )

  // A vendor with no published rate gets an honest gap, not an invented figure.
  const vol = estimateLookupSpend(here, 300_000)
  ok(vol.kind === 'unknown', 'a volume-priced vendor produces no number')
  const volText = describeSpend(vol)?.text ?? ''
  ok(/check your/i.test(volText) && !/\$/.test(volText), 'and says to check the account rather than quoting one')

  // Every warning must name the provider being billed — an operator cannot
  // check a charge against an account the sentence never mentions.
  for (const [label, est] of [['Google', big], ['Geocodio', gc], ['HERE', vol]]) {
    ok(new RegExp(label).test(describeSpend(est)?.text ?? ''), `the ${label} warning names ${label}`)
  }
}

/* ========== 2. the screen =============================================== */
const browser = await chromium.launch({ executablePath: chromiumPath() })
{
  const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true })
  const page = await ctx.newPage()

  const USER = {
    id: 'u_admin', clientId: 'c_live', clientName: 'Ridgeline Roofing',
    email: 'boss@ridgeline.test', name: 'Dale Ridge', role: 'client_admin',
  }

  // The response shape the Worker actually returns: catalogue plus saved rows,
  // and a masked hint in place of anything resembling a key.
  const payload = {
    providers: GEOCODE_PROVIDERS,
    configured: [{ provider: 'google', active: true, hint: 'AIza…9fQ4', status: 'active' }],
    active: 'google',
    /*
      Lookups already sent on the key. The panel fetched this and rendered none
      of it, which is how a screen listing a price beside every vendor still
      left an operator unsure what they were being billed: a list price says
      what a lookup costs, not what this company has spent.
    */
    usage: { today: 120, month: 3400 },
  }

  const json = (body) => (route) =>
    route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(body) })

  /*
    The catch-all is registered FIRST, and that ordering is the whole of it.

    Playwright matches route handlers in reverse registration order, so a
    catch-all added last silently wins over every specific handler above it —
    including sign-in. The first version of this gate did exactly that and
    reported the settings tab as unreachable, when what had actually happened is
    that the app never got past the login screen.
  */
  await page.route('**/api/**', (route) => route.fulfill({ status: 200, contentType: 'application/json', body: '{}' }))
  await page.route('**/api/auth/login', json({ token: 'tok_1', user: USER }))
  await page.route('**/api/bootstrap', json({
    user: USER, properties: [], routes: [], appointments: [], tasks: [],
    activity: [], dailyStats: [], serverTime: Date.now(),
  }))
  await page.route('**/api/geocoders', json(payload))

  await page.goto(BASE, { waitUntil: 'networkidle' })
  await page.locator('input[type="email"]').fill(USER.email)
  await page.locator('input[autocomplete="current-password"]').fill('pw')
  await page.getByRole('button', { name: /^Sign in$/ }).click()
  await page.waitForTimeout(1500)
  /*
    A real sign-in is a first run, and the first run opens the tour — which
    navigates to its own anchor screens. Left running it pulls the page off
    /admin/settings about a second after arriving, and the failure reads as
    "the settings route does not exist".
  */
  await dismissTour(page)

  await page.goto(`${BASE}/admin/settings`, { waitUntil: 'domcontentloaded' })
  await page.waitForTimeout(1600)
  const tab = page.getByRole('button', { name: /Address lookup/ }).first()
  if ((await tab.count()) === 0) {
    const seen = (await page.locator('body').innerText()).replace(/\s+/g, ' ').trim()
    console.log(`  url:    ${page.url()}\n  screen: ${seen.slice(0, 300) || '(empty)'}`)
    ok(false, 'the Address lookup tab is reachable from admin settings')
  } else {
    await tab.click()
    await page.waitForTimeout(900)

    const body = (await page.locator('body').innerText()).replace(/\s+/g, ' ')

    // Every provider is on the screen, named. A company cannot choose from a
    // list that only shows what we happen to have built.
    const missing = GEOCODE_PROVIDERS.filter((p) => !body.includes(p.label))
    ok(missing.length === 0, `all ${GEOCODE_PROVIDERS.length} providers are listed${missing.length ? ` — missing ${missing.map((p) => p.label).join(', ')}` : ''}`)

    ok(/30 days only/.test(body), 'a temporary-storage provider says so on its own row')
    ok(/Not connected yet/.test(body), 'a provider with no adapter is marked unavailable')
    ok(/Key on file: AIza…9fQ4/.test(body), 'a saved key shows as a mask, not a value')
    ok(/In use/.test(body), 'the provider actually in use is identifiable')

    /* --- what it is costing, not just what it lists at -------------------- */
    ok(
      /Google bills you directly/.test(body),
      'the screen says who charges for a lookup, and that it is not us',
    )
    ok(/3,400/.test(body), 'and how many lookups have gone through the key this month')
    // 10,000 free a month, 3,400 already spent. The arithmetic is the point:
    // an allowance reported at its full size is the one that gets overrun.
    ok(
      /6,600/.test(body),
      'and what is left of the free allowance, net of what has already gone',
      body.match(/About [^.]*\./)?.[0] ?? '',
    )
    ok(
      /minimum/i.test(body),
      'and that the figure is a floor, since the same key used elsewhere is invisible to us',
    )

    // The one that matters most. Nothing on this screen may render a whole key,
    // and the mask is deliberately short enough that a full one is longer.
    const leaked = await page.evaluate(() =>
      /AIza[0-9A-Za-z_-]{20,}/.test(document.body.innerText),
    )
    ok(!leaked, 'no full API key appears anywhere in the rendered page')

    // A provider we cannot call must not offer a way to hand it a key.
    const plannedLabel = GEOCODE_PROVIDERS.find((p) => p.adapter === 'planned')?.label
    const row = page.locator('li').filter({ hasText: plannedLabel }).first()
    const addButtons = await row.getByRole('button', { name: /Add key|Use / }).count()
    ok(addButtons === 0, `${plannedLabel} offers no way to connect it while it cannot be called`)
  }

  await ctx.close()
}

/* ========== 3. a field rep cannot reach any of it ======================= */
{
  const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true })
  const page = await ctx.newPage()
  const REP = {
    id: 'u_rep', clientId: 'c_live', clientName: 'Ridgeline Roofing',
    email: 'rep@ridgeline.test', name: 'Marcus Vance', role: 'field_rep',
  }
  const json = (body) => (route) =>
    route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(body) })

  await page.route('**/api/**', (route) => route.fulfill({ status: 200, contentType: 'application/json', body: '{}' }))
  await page.route('**/api/auth/login', json({ token: 'tok_2', user: REP }))
  await page.route('**/api/bootstrap', json({
    user: REP, properties: [], routes: [], appointments: [], tasks: [],
    activity: [], dailyStats: [], serverTime: Date.now(),
  }))
  // If the rep's client ever calls this, the server would 403 — but the screen
  // should never get far enough to ask.
  await page.route('**/api/geocoders', (route) =>
    route.fulfill({ status: 403, contentType: 'application/json', body: '{"error":"Not permitted."}' }))

  await page.goto(BASE, { waitUntil: 'networkidle' })
  await page.locator('input[type="email"]').fill(REP.email)
  await page.locator('input[autocomplete="current-password"]').fill('pw')
  await page.getByRole('button', { name: /^Sign in$/ }).click()
  await page.waitForTimeout(1500)
  await dismissTour(page)

  await page.goto(`${BASE}/more`, { waitUntil: 'domcontentloaded' })
  await page.waitForTimeout(700)
  ok(
    (await page.getByRole('button', { name: /Admin console/ }).count()) === 0,
    'a field rep is not offered the admin console at all',
  )
  await ctx.close()
}

await browser.close()

if (fails.length) {
  console.log(`\n${fails.length} geocoder check(s) failed`)
  process.exit(1)
}
console.log('\ncompanies can bring their own geocoder, and are told what they are agreeing to')
