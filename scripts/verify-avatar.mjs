import { chromium } from 'playwright'
import { dismissTour } from './lib/tour.mjs'

/**
 * Profile photos.
 *
 * The claim being tested is the one this app makes about every write: it is on
 * the device before it is anywhere else, and it is still there after the app
 * dies. A photo that appears and then vanishes on reload is worse than no photo
 * feature, because the person believes it worked.
 */

const BASE = process.env.BASE_URL || 'http://127.0.0.1:4173'
const browser = await chromium.launch({
  executablePath: '/opt/pw-browsers/chromium-1194/chrome-linux/chrome',
})
const ctx = await browser.newContext({
  viewport: { width: 390, height: 844 },
  isMobile: true,
  hasTouch: true,
})
const page = await ctx.newPage()
const fails = []
const ok = (cond, msg) => {
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${msg}`)
  if (!cond) fails.push(msg)
}

const errors = []
page.on('pageerror', (e) => errors.push(String(e)))

await page.goto(BASE, { waitUntil: 'networkidle' })
await page.getByRole('button', { name: /Try the demo/ }).click()
await page.getByRole('button', { name: /Dana Whitfield/ }).click()
await dismissTour(page)
await page.waitForTimeout(1400)
await page.goto(`${BASE}/more`, { waitUntil: 'domcontentloaded' })
await page.waitForTimeout(900)

const picker = page.getByRole('button', { name: /profile photo/i })
ok((await picker.count()) > 0, 'the avatar is a control, and says what it does')
ok(
  /Add a profile photo/i.test((await picker.getAttribute('aria-label')) ?? ''),
  'it offers to add one when there is none',
)
ok((await page.getByRole('button', { name: 'Remove photo' }).count()) === 0,
   'no remove action when there is no photo to remove')

/*
 * A real JPEG, built here rather than committed.
 *
 * 2x2 red pixels — enough for the browser to decode, crop and re-encode, which
 * is the part that matters. A fixture file would be one more thing to keep in
 * step with a helper it is meant to exercise.
 */
const jpeg = Buffer.from(
  '/9j/4AAQSkZJRgABAQEAYABgAAD/2wBDAAgGBgcGBQgHBwcJCQgKDBQNDAsLDBkSEw8UHRofHh0a' +
  'HBwgJC4nICIsIxwcKDcpLDAxNDQ0Hyc5PTgyPC4zNDL/wAALCAACAAIBAREA/8QAHwAAAQUBAQEB' +
  'AQEAAAAAAAAAAAECAwQFBgcICQoL/8QAtRAAAgEDAwIEAwUFBAQAAAF9AQIDAAQRBRIhMUEGE1Fh' +
  'ByJxFDKBkaEII0KxwRVS0fAkM2JyggkKFhcYGRolJicoKSo0NTY3ODk6Q0RFRkdISUpTVFVWV1hZ' +
  'WmNkZWZnaGlqc3R1dnd4eXqDhIWGh4iJipKTlJWWl5iZmqKjpKWmp6ipqrKztLW2t7i5usLDxMXG' +
  'x8jJytLT1NXW19jZ2uHi4+Tl5ufo6erx8vP09fb3+Pn6/9oACAEBAAA/APn+v//Z',
  'base64',
)
await page.setInputFiles('input[type=file]', {
  name: 'me.jpg',
  mimeType: 'image/jpeg',
  buffer: jpeg,
})
await page.waitForTimeout(1200)

const img = page.locator('button[aria-label*="profile photo" i] img')
ok((await img.count()) > 0, 'the photo replaces the initials')
const src = (await img.getAttribute('src')) ?? ''
ok(src.startsWith('data:image/jpeg'), 'it is stored as a compressed JPEG data URL')

/*
 * Size is the whole reason this does not reuse the property-photo path: a
 * 1600px re-encode would be ~180KB of one face, downloaded by every teammate.
 *
 * Measured as *pixels*, not bytes. The fixture below is a 2x2 flat colour, and
 * a flat colour compresses to nothing at any resolution — so a byte check here
 * passes just as happily on a 1600px avatar as a 256px one, which makes it a
 * test that cannot fail. The intrinsic dimensions of the decoded image pin the
 * actual decision. The byte ceiling stays as a second, looser guard, since the
 * server enforces one too.
 */
const decoded = await page.evaluate(
  (dataUrl) =>
    new Promise((resolve) => {
      const im = new Image()
      im.onload = () => resolve({ w: im.naturalWidth, h: im.naturalHeight })
      im.onerror = () => resolve({ w: 0, h: 0 })
      im.src = dataUrl
    }),
  src,
)
ok(
  decoded.w === 256 && decoded.h === 256,
  `the avatar is re-encoded to 256x256 (got ${decoded.w}x${decoded.h})`,
)
const bytes = Math.round((src.length - src.indexOf(',') - 1) * 0.75)
ok(bytes > 0 && bytes < 64_000, `and stays under the server's ceiling (${bytes} bytes)`)

const box = await img.boundingBox()
ok(
  box !== null && Math.abs(box.width - box.height) <= 1,
  'it is square on screen, so a face is not stretched',
)

ok(
  /Change your profile photo/i.test((await picker.getAttribute('aria-label')) ?? ''),
  'the control now offers to change it',
)
ok((await page.getByRole('button', { name: 'Remove photo' }).count()) === 1,
   'and offers to remove it')

/* --- the durability claim ------------------------------------------------- */
await page.reload({ waitUntil: 'networkidle' })
await page.waitForTimeout(1500)
const after = page.locator('button[aria-label*="profile photo" i] img')
ok((await after.count()) > 0, 'the photo survives a reload')
ok((await after.getAttribute('src')) === src, 'and it is the same image, not a re-render')

/*
 * Setting a photo must not shrink the roster.
 *
 * A field rep's `team` store is empty — they get the names-only roster off
 * bootstrap instead, and `loadLocal` only falls back to it when the store has
 * nothing in it. So caching one member there to remember their own face would
 * leave the next load with a team of exactly one person: themselves. The board
 * would go from eight names to one, which is a bug this app has already had
 * once and is worth never having again.
 */
await page.goto(`${BASE}/standings`, { waitUntil: 'domcontentloaded' })
await page.waitForTimeout(1200)
const onBoard = await page.locator('ul.plate > li').count()
ok(onBoard > 1, `the whole board survives setting a photo (${onBoard} people)`)
await page.goto(`${BASE}/more`, { waitUntil: 'domcontentloaded' })
await page.waitForTimeout(900)

/* --- removing means removed ----------------------------------------------- */
await page.getByRole('button', { name: 'Remove photo' }).click()
await page.waitForTimeout(700)
ok(
  (await page.locator('button[aria-label*="profile photo" i] img').count()) === 0,
  'removing it brings the initials back',
)
await page.reload({ waitUntil: 'networkidle' })
await page.waitForTimeout(1500)
ok(
  (await page.locator('button[aria-label*="profile photo" i] img').count()) === 0,
  'and it stays removed after a reload',
)

/*
 * Demo mode queues nothing. There is no account behind a demo user, so a
 * `user.avatar` mutation could never be accepted — and a permanently stuck row
 * is visible on this very screen, in a number a prospect can read.
 */
const queued = await page.evaluate(async () => {
  const open = indexedDB.open('allstar')
  const db = await new Promise((res, rej) => {
    open.onsuccess = () => res(open.result)
    open.onerror = () => rej(open.error)
  })
  if (!db.objectStoreNames.contains('outbox')) return []
  const tx = db.transaction('outbox', 'readonly')
  const all = await new Promise((res) => {
    const req = tx.objectStore('outbox').getAll()
    req.onsuccess = () => res(req.result)
    req.onerror = () => res([])
  })
  return all.map((m) => m.kind)
})
ok(!queued.includes('user.avatar'), 'the demo queues no avatar mutation it cannot deliver')

ok(errors.length === 0, `no page errors${errors.length ? ` -> ${errors[0]}` : ''}`)

await browser.close()
console.log(`\n${fails.length ? `${fails.length} FAILED` : '=== profile photos OK ==='}`)
process.exit(fails.length ? 1 : 0)
