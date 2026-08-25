import { chromium } from 'playwright'
import { dismissTour } from './lib/tour.mjs'

/**
 * Photos leaving the phone.
 *
 * The bytes used to stay on the device forever: the metadata row went up with
 * every other write, `apiUploadPhoto` existed, and nothing ever called it. So
 * the assertions here are about the request actually happening, and about what
 * the rep is told while it hasn't.
 *
 * The four states a photo can be in are all reachable from a server that is
 * simply configured differently, which is why each one gets its own sign-in
 * rather than a shared session: a queue that has already given up behaves
 * nothing like one that hasn't.
 */

const BASE = process.env.BASE_URL || 'http://127.0.0.1:4173'
const browser = await chromium.launch({
  executablePath: '/opt/pw-browsers/chromium-1194/chrome-linux/chrome',
})

const fails = []
const ok = (cond, msg) => {
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${msg}`)
  if (!cond) fails.push(msg)
}

const errors = []

const REP = {
  id: 'u_rep',
  clientId: 'c_live',
  clientName: 'Ridgeline Roofing',
  email: 'rep@ridgeline.test',
  name: 'Marcus Vance',
  role: 'field_rep',
}

const PROPERTY = {
  id: 'p0',
  address1: '118 Cedar Bend Dr',
  city: 'Round Rock',
  state: 'TX',
  zip: '78664',
  lat: 30.5115,
  lng: -97.6755,
  status: 'new',
  score: 60,
  assignedRepId: REP.id,
  contacts: [],
}

/** 2x2 red pixels — small, and a real decodable JPEG. */
const JPEG = Buffer.from(
  '/9j/4AAQSkZJRgABAQEAYABgAAD/2wBDAAgGBgcGBQgHBwcJCQgKDBQNDAsLDBkSEw8UHRofHh0a' +
    'HBwgJC4nICIsIxwcKDcpLDAxNDQ0Hyc5PTgyPC4zNDL/wAALCAACAAIBAREA/8QAHwAAAQUBAQEB' +
    'AQEAAAAAAAAAAAECAwQFBgcICQoL/8QAtRAAAgEDAwIEAwUFBAQAAAF9AQIDAAQRBRIhMUEGE1Fh' +
    'ByJxFDKBkaEII0KxwRVS0fAkM2JyggkKFhcYGRolJicoKSo0NTY3ODk6Q0RFRkdISUpTVFVWV1hZ' +
    'WmNkZWZnaGlqc3R1dnd4eXqDhIWGh4iJipKTlJWWl5iZmqKjpKWmp6ipqrKztLW2t7i5usLDxMXG' +
    'x8jJytLT1NXW19jZ2uHi4+Tl5ufo6erx8vP09fb3+Pn6/9oACAEBAAA/APn+v//Z',
  'base64',
)

const json = (status, body) => (route) =>
  route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) })

/**
 * Sign in against a mock whose photo endpoint answers however this test needs.
 *
 * `onUpload` is handed the request and returns what the server would say. Every
 * call is recorded, because "how many times did it ask" is the assertion for
 * two of the four states and cannot be seen any other way.
 */
async function signIn(onUpload) {
  const ctx = await browser.newContext({
    viewport: { width: 390, height: 844 },
    isMobile: true,
    hasTouch: true,
  })
  const page = await ctx.newPage()
  page.on('pageerror', (e) => errors.push(String(e)))
  const uploads = []

  await page.route('**/api/auth/login', json(200, { token: 'tok', user: REP }))
  await page.route('**/api/bootstrap', json(200, {
    user: REP,
    properties: [PROPERTY],
    routes: [],
    appointments: [],
    tasks: [],
    activity: [],
    dailyStats: [],
    serverTime: Date.now(),
  }))
  await page.route('**/api/mutations', async (route) => {
    const body = JSON.parse(route.request().postData() || '{}')
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        results: (body.mutations ?? []).map((m) => ({ id: m.id, status: 'applied' })),
        serverTime: Date.now(),
      }),
    })
  })
  await page.route('**/api/photos/**', async (route) => {
    uploads.push({
      method: route.request().method(),
      bytes: (route.request().postDataBuffer() ?? Buffer.alloc(0)).byteLength,
    })
    await onUpload(route)
  })

  await page.goto(BASE, { waitUntil: 'networkidle' })
  await page.locator('input[type="email"]').fill(REP.email)
  await page.locator('input[autocomplete="current-password"]').fill('a-real-password')
  await page.getByRole('button', { name: /^Sign in$/ }).click()
  await page.waitForTimeout(1600)
  await dismissTour(page)
  return { ctx, page, uploads }
}

/** Shoot a photo on the property screen and file it under Roof. */
async function shoot(page) {
  await page.goto(`${BASE}/property/${PROPERTY.id}`, { waitUntil: 'domcontentloaded' })
  await page.waitForTimeout(900)

  const photos = page.getByRole('button', { name: /^Photos/ })
  if ((await photos.count()) > 0) {
    const expanded = await photos.first().getAttribute('aria-expanded')
    if (expanded === 'false') await photos.first().click()
    await page.waitForTimeout(400)
  }

  /*
    Through the camera button, not by reaching for a hidden input.

    There isn't one to reach for: `openCamera` builds the input on the tap and
    removes it again, which is what makes the OS camera open rather than a file
    picker. Driving it through the chooser exercises that path as well.
  */
  const chooser = page.waitForEvent('filechooser')
  await page.getByRole('button', { name: 'Take photo' }).click()
  await (await chooser).setFiles({ name: 'roof.jpg', mimeType: 'image/jpeg', buffer: JPEG })
  await page.waitForTimeout(1200)
  await page.getByRole('button', { name: /Roof/i }).first().click()
  await page.waitForTimeout(1200)
}

const tally = (page) => page.locator('p', { hasText: /^\d+ photos? · / }).first()

/* --- 1. a photo taken with no signal ---------------------------------------- */
{
  const { ctx, page, uploads } = await signIn(json(200, { ok: true, key: 'k' }))

  // A real dead link rather than the app's simulate switch: the queue asks
  // `navigator.onLine`, and only the browser can actually change that answer.
  await ctx.setOffline(true)
  await page.evaluate(() => window.dispatchEvent(new Event('offline')))
  await page.waitForTimeout(500)

  await shoot(page)

  const thumbs = page.locator('button.press.relative img')
  ok((await thumbs.count()) === 1, 'the photo is on screen the moment it is taken')
  ok(uploads.length === 0, 'and nothing was sent, because there is no signal')

  const line = await tally(page).innerText()
  ok(/waiting to upload/i.test(line), `the rep is told it is waiting — "${line.trim()}"`)
  ok(
    (await page.locator('[title="Waiting to upload"]').count()) === 1,
    'and the thumbnail carries the waiting mark',
  )

  /* --- 2. signal comes back ------------------------------------------------- */
  await ctx.setOffline(false)
  await page.evaluate(() => window.dispatchEvent(new Event('online')))
  await page.waitForTimeout(3000)

  ok(uploads.length >= 1, 'the bytes go up as soon as there is signal')
  ok(uploads[0]?.method === 'POST', 'as a POST to the photo endpoint')
  ok(uploads[0]?.bytes > 100, `carrying the image itself (${uploads[0]?.bytes} bytes)`)

  await page.goto(`${BASE}/property/${PROPERTY.id}`, { waitUntil: 'domcontentloaded' })
  await page.waitForTimeout(1000)
  const after = await tally(page).innerText()
  ok(/uploaded/i.test(after), `and the rep is told so — "${after.trim()}"`)
  ok(
    (await page.locator('[title="Waiting to upload"]').count()) === 0,
    'the waiting mark is gone',
  )

  const before = uploads.length
  await page.waitForTimeout(2500)
  ok(uploads.length === before, 'an uploaded photo is not sent a second time')

  await ctx.close()
}

/* --- 3. a deployment with no photo storage ---------------------------------- */
//
// The state this app is actually in today, and the one most likely to be got
// wrong: the danger is not that the upload fails, it is that the client keeps
// asking forever and shows the rep a failure they cannot do anything about.
{
  const { ctx, page, uploads } = await signIn(
    json(503, { error: 'Photo storage is not enabled on this deployment.', code: 'no_photo_storage' }),
  )
  await shoot(page)
  await page.waitForTimeout(3000)

  ok(uploads.length >= 1, 'the client tries once')
  const asked = uploads.length
  await page.waitForTimeout(4000)
  ok(uploads.length === asked, 'and having been told there is nowhere to put it, stops asking')

  const line = await tally(page).innerText()
  ok(/kept on this phone/i.test(line), `the rep is told where it is — "${line.trim()}"`)
  ok(!/waiting|failed/i.test(line), 'and it is not dressed up as a failure')
  ok(
    (await page.locator('[title="Waiting to upload"]').count()) === 0,
    'no waiting mark for something that is not waiting',
  )

  await page.goto(`${BASE}/more`, { waitUntil: 'domcontentloaded' })
  await page.waitForTimeout(900)
  const queue = page.getByRole('button', { name: /^Upload queue/ })
  ok(
    !/\b[1-9]\d*\b/.test((await queue.first().innerText()).replace(/upload queue/i, '')),
    'and the upload queue does not count it as outstanding',
  )

  await ctx.close()
}

/* --- 4. photo storage is switched on later ---------------------------------- */
//
// The deploy-day case, and the one that strands photos silently.
//
// A photo marked local is not owed, so it is not in the queue, not in the
// count, and there is no failure for anyone to retry. Without a re-ask, turning
// storage on leaves every photo taken before the deploy on the phone forever —
// and the only symptom is a rep saying the office never got their roof shots.
{
  let storage = false
  const { ctx, page, uploads } = await signIn(async (route) =>
    storage
      ? route.fulfill({ status: 200, contentType: 'application/json', body: '{"ok":true,"key":"k"}' })
      : route.fulfill({
          status: 503,
          contentType: 'application/json',
          body: JSON.stringify({ error: 'no storage', code: 'no_photo_storage' }),
        }),
  )

  await shoot(page)
  await page.waitForTimeout(2500)
  ok(
    /kept on this phone/i.test(await tally(page).innerText()),
    'a photo taken before storage exists is kept on the phone',
  )

  // The deploy. Nothing changes on the phone; the server simply starts saying
  // yes — and the app is reloaded, which is what a rep opening it tomorrow does.
  storage = true
  const asked = uploads.length
  await page.reload({ waitUntil: 'domcontentloaded' })
  await page.waitForTimeout(4000)

  ok(uploads.length > asked, 'the next launch asks again rather than giving up forever')

  await page.goto(`${BASE}/property/${PROPERTY.id}`, { waitUntil: 'domcontentloaded' })
  await page.waitForTimeout(1200)
  const line = await tally(page).innerText()
  ok(/uploaded/i.test(line), `and the photo goes up on its own — "${line.trim()}"`)

  await ctx.close()
}

/* --- 5. the server is broken ------------------------------------------------ */
{
  const { ctx, page, uploads } = await signIn(json(500, { error: 'Something went wrong.' }))
  await shoot(page)
  await page.waitForTimeout(3000)

  ok(uploads.length >= 1, 'a broken server is tried')
  const line = await tally(page).innerText()
  ok(
    /waiting to upload/i.test(line),
    `and the photo stays owed rather than being written off — "${line.trim()}"`,
  )

  // Backoff, not a spin. Eight tries at 1s, 2s, 4s… cannot fit in five seconds;
  // a retry loop with no backoff would run to dozens.
  const asked = uploads.length
  await page.waitForTimeout(5000)
  ok(
    uploads.length - asked <= 3,
    `it backs off instead of hammering the radio (${uploads.length - asked} more tries in 5s)`,
  )

  await ctx.close()
}

ok(errors.length === 0, `no page errors${errors.length ? ` — ${errors[0]}` : ''}`)

await browser.close()

if (fails.length) {
  console.log(`\n${fails.length} failed:`)
  fails.forEach((f) => console.log(`  - ${f}`))
  process.exit(1)
}
console.log('\n=== photos OK ===')
