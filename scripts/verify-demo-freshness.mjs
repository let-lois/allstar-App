import { chromium } from 'playwright'
import { chromiumPath } from './lib/browser.mjs'
import { dismissTour } from './lib/tour.mjs'

/**
 * Demo-freshness check.
 *
 * The demo is pitched from a persistent local cache, so it has to look like
 * "today" whenever it is opened — not only on the day it was first loaded.
 * This boots the app, jumps the device clock forward, reloads, and asserts the
 * Today screen still has a live route, appointments and activity.
 *
 * Without this the demo silently empties out overnight, which is discovered in
 * front of a prospect.
 *
 * It also has to look like today at whatever *hour* it is opened, and that half
 * was missing for a long time because this gate only ever jumped whole days —
 * 86,400,000 ms preserves the hour exactly, so every check ran at the same time
 * of day as the machine happened to be at. Underneath, the seed laid a rep's day
 * out backwards from "now" with nothing stopping it at the start of the day, and
 * every screen in the app filters activity on "since midnight". A demo opened at
 * 6am showed a team who had knocked one door between them: no appointments, no
 * revenue, no board. So the second half of this file walks the clock around the
 * early morning and asserts the day does not change shape.
 */

const BASE = process.env.BASE_URL || 'http://127.0.0.1:4173'
const DAYS_FORWARD = Number(process.env.DAYS_FORWARD || 4)

const browser = await chromium.launch({
  executablePath: chromiumPath(),
})
const ctx = await browser.newContext({
  viewport: { width: 390, height: 844 },
  isMobile: true,
  hasTouch: true,
  permissions: ['geolocation'],
  geolocation: { latitude: 30.5115, longitude: -97.6755 },
})

const fails = []
const ok = (cond, msg) => {
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${msg}`)
  if (!cond) fails.push(msg)
}

const page = await ctx.newPage()
await page.goto(BASE, { waitUntil: 'networkidle' })
await page.getByRole('button', { name: /Try the demo/ }).click()
await page.getByRole('button', { name: /Dana Whitfield/ }).click()
await dismissTour(page)
await page.waitForTimeout(1200)

/** Read the counters the pitch actually depends on. */
const snapshot = async (p = page) => {
  return p.evaluate(() => {
    const text = document.body.innerText
    const progress = text.match(/(\d+)\s*\/\s*(\d+)/)
    const section = (name) => {
      // Section headings render as "<name> <count>"
      const re = new RegExp(`${name}\\s*\\n?\\s*(\\d+)`)
      const m = text.match(re)
      return m ? Number(m[1]) : 0
    }
    return {
      routeTotal: progress ? Number(progress[2]) : 0,
      appointments: section('Appointments'),
      followUps: section('Follow-ups'),
      activity: section("Today's activity"),
      hasNextStop: /NEXT STOP/i.test(text),
    }
  })
}

const day0 = await snapshot()
console.log('  day 0:', JSON.stringify(day0))
ok(day0.routeTotal > 0, 'day 0: route has stops')
ok(day0.appointments > 0, 'day 0: appointments present')
ok(day0.activity > 0, 'day 0: today activity present')
ok(day0.hasNextStop, 'day 0: next stop card shown')

// Jump the device clock forward. The cache persists, so this is exactly what a
// prospect sees when the demo is reopened days later.
await ctx.addInitScript((days) => {
  const offset = days * 86400000
  const RealDate = Date
  const shifted = new RealDate(RealDate.now() + offset)
  // eslint-disable-next-line no-global-assign
  Date = class extends RealDate {
    constructor(...args) {
      if (args.length === 0) super(RealDate.now() + offset)
      else super(...args)
    }
    static now() {
      return RealDate.now() + offset
    }
  }
  Date.parse = RealDate.parse
  Date.UTC = RealDate.UTC
  void shifted
}, DAYS_FORWARD)

await page.reload({ waitUntil: 'networkidle' })
await page.waitForTimeout(2000)

const dayN = await snapshot()
console.log(`  day +${DAYS_FORWARD}:`, JSON.stringify(dayN))

ok(dayN.routeTotal > 0, `day +${DAYS_FORWARD}: route still has stops`)
ok(dayN.hasNextStop, `day +${DAYS_FORWARD}: next stop card still shown`)
ok(dayN.appointments > 0, `day +${DAYS_FORWARD}: appointments still present`)
ok(dayN.activity > 0, `day +${DAYS_FORWARD}: today activity still present`)

/* ========== the same day, opened at different hours ====================== */
//
// A fresh context per hour, because the clock has to be wrong from the first
// line of script the page runs — and because these must not compound with the
// day-jump shim already installed above. A fresh context also has no cache, so
// the seed is built at the shifted hour, which is the same code path a returning
// prospect takes when the day has rolled over and the bundle is regenerated.
//
// All three hours sit before the first seeded appointment at 1pm, so a
// difference between them is a difference in the generated day and nothing else.
const HOURS = [0, 4, 8]

/** Open the demo with the device clock moved to `hour` today. */
async function openAt(hour) {
  const c = await browser.newContext({
    viewport: { width: 390, height: 844 },
    isMobile: true,
    hasTouch: true,
    permissions: ['geolocation'],
    geolocation: { latitude: 30.5115, longitude: -97.6755 },
  })
  await c.addInitScript((h) => {
    const RealDate = Date
    const target = new RealDate()
    target.setHours(h, 10, 0, 0)
    const offset = target.getTime() - RealDate.now()
    // eslint-disable-next-line no-global-assign
    Date = class extends RealDate {
      constructor(...args) {
        if (args.length === 0) super(RealDate.now() + offset)
        else super(...args)
      }
      static now() {
        return RealDate.now() + offset
      }
    }
    Date.parse = RealDate.parse
    Date.UTC = RealDate.UTC
  }, hour)
  const p = await c.newPage()
  await p.goto(BASE, { waitUntil: 'networkidle' })
  await p.getByRole('button', { name: /Try the demo/ }).click()
  await p.getByRole('button', { name: /Dana Whitfield/ }).click()
  await dismissTour(p)
  await p.waitForTimeout(1500)
  const shot = await snapshot(p)
  await c.close()
  return shot
}

const byHour = []
for (const hour of HOURS) {
  const shot = await openAt(hour)
  console.log(`  ${String(hour).padStart(2, '0')}:10 —`, JSON.stringify(shot))
  byHour.push({ hour, shot })
  ok(shot.routeTotal > 0, `${hour}:10 — the route has stops`)
  ok(shot.hasNextStop, `${hour}:10 — there is a next stop to walk to`)
  ok(shot.appointments > 0, `${hour}:10 — the day has appointments in it`)
  ok(shot.activity > 0, `${hour}:10 — the morning's doors are counted as today's`)
}

/*
  The assertion that actually catches it. Each hour above is non-empty on its
  own, and the broken version passed exactly that: at midnight the rep still had
  one door logged, which is greater than zero and nothing like a day's work.
  What has to hold is that the hour the demo is opened at does not change the
  day it shows.
*/
const first = byHour[0]
for (const { hour, shot } of byHour.slice(1)) {
  ok(
    shot.activity === first.shot.activity,
    `the day is the same size at ${hour}:10 as at ${first.hour}:10 (${shot.activity} vs ${first.shot.activity} doors)`,
  )
  ok(
    shot.routeTotal === first.shot.routeTotal &&
      shot.appointments === first.shot.appointments,
    `and so is the route and the diary (${shot.routeTotal}/${shot.appointments} vs ${first.shot.routeTotal}/${first.shot.appointments})`,
  )
}

await browser.close()
console.log(fails.length ? `\n${fails.length} FAILURES` : '\ndemo stays fresh')
process.exit(fails.length ? 1 : 0)
