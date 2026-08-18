import { chromium } from 'playwright'

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
 */

const BASE = process.env.BASE_URL || 'http://127.0.0.1:4173'
const DAYS_FORWARD = Number(process.env.DAYS_FORWARD || 4)

const browser = await chromium.launch({
  executablePath: '/opt/pw-browsers/chromium-1194/chrome-linux/chrome',
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
await page.waitForTimeout(1200)

/** Read the counters the pitch actually depends on. */
const snapshot = async () => {
  return page.evaluate(() => {
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

await browser.close()
console.log(fails.length ? `\n${fails.length} FAILURES` : '\ndemo stays fresh')
process.exit(fails.length ? 1 : 0)
