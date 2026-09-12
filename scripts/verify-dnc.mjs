import { chromium } from 'playwright'
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { homeownerContact } from '../src/lib/contact.ts'

/**
 * A household marked Do Not Contact cannot be contacted from the app.
 *
 * The bug this pins: `do_not_contact` was a terminal outcome that dropped a
 * property out of pipeline counts and out of route building, and did nothing
 * else. `CommActions` rendered one-tap Call, Text and Email without reading
 * `property.status`, on the property screen, the map's bottom sheet and inside
 * Visit Mode. `PropertyRow` offered swipe-left-to-call from any list. Marking a
 * household Do Not Contact changed the reports and not the app's ability to
 * contact them.
 *
 * Three kinds of check, because no one of them is enough on its own.
 *
 * **The rule, tested directly.** `homeownerContact` is the whole decision, so it
 * is exercised as a function — fast, and it can be asked things a browser cannot
 * easily be asked, like whether a blocked property with a perfectly good phone
 * number still returns nothing to call.
 *
 * **The shape, tested structurally.** This is the half that stops the bug coming
 * back. There were four paths to a live `tel:` and the swipe was added later by
 * someone with no reason to know a check existed. So the gate asserts the raw
 * link builders are unreachable: `smsHref` and `mailHref` are not exported from
 * `format.ts` at all, and `telHref` is imported only by files on a short
 * allowlist. Adding a fifth contact surface the wrong way fails here.
 *
 * **The screen, tested in a browser.** With a real Do Not Contact property that
 * really has a phone number — and, as the control, a normal property that also
 * has one. Without the control, "no `tel:` links on this page" passes just as
 * happily on a build where the buttons were deleted outright, or on a run that
 * navigated to the wrong screen.
 *
 * The swipe on `PropertyRow` is covered structurally rather than in the browser:
 * its label only enters the DOM part-way through a drag, so a simulated touch
 * would be testing the gesture library. The regression that matters there is
 * someone reaching for `telHref` again, and the allowlist catches exactly that.
 */

const BASE = process.env.BASE_URL || 'http://127.0.0.1:4173'
const root = resolve(fileURLToPath(import.meta.url), '../..')

const fails = []
const ok = (c, m, measured) => {
  console.log(`${c ? 'PASS' : 'FAIL'}  ${m}${measured ? `  (${measured})` : ''}`)
  if (!c) fails.push(m)
}

/* --- 1. the rule itself ---------------------------------------------------- */

const person = { id: 'c1', name: 'Marguerite Adeyemi', phone: '512-555-0148', email: 'm@example.com', isPrimary: true }
const propertyWith = (status) => ({
  id: 'p1', address1: '4417 Sundapple Ter', city: 'Round Rock', state: 'TX', zip: '78664',
  lat: 30.5, lng: -97.6, status, score: 50, contacts: [person], updatedAt: 0,
})

{
  const allowed = homeownerContact(propertyWith('working'))
  ok(!!allowed.tel && !!allowed.sms && !!allowed.mail, 'a working lead gets call, text and email')
  ok(allowed.blocked === null, 'and is not blocked')
  ok(allowed.tel?.startsWith('tel:') === true, 'the call link is a real tel: link', allowed.tel)
}

{
  const blocked = homeownerContact(propertyWith('dnc'))
  // The phone number is present and valid. That is the point: the block has to
  // beat the data, not merely coincide with missing data.
  ok(blocked.blocked !== null, 'a Do Not Contact household is blocked')
  ok(
    blocked.tel === undefined && blocked.sms === undefined && blocked.mail === undefined,
    'and gets no call, text or email link — with a valid number on file',
  )
  ok(
    typeof blocked.blocked?.reason === 'string' && blocked.blocked.reason.length > 10,
    'and carries a reason a rep can read',
    blocked.blocked?.reason,
  )
  ok(blocked.person?.name === person.name, 'the person is still identified, so the screen can say who')
}

{
  // Closing a lead is not withdrawing permission. A customer who bought can
  // still be rung about the job they bought.
  for (const status of ['won', 'lost', 'appointment', 'quoted', 'new', 'contacted']) {
    const r = homeownerContact(propertyWith(status))
    if (r.blocked !== null) fails.push(`${status} should not block contact`)
  }
  ok(!fails.some((f) => f.endsWith('should not block contact')), 'no other status withdraws contact')
}

{
  const noPhone = homeownerContact({ ...propertyWith('working'), contacts: [{ id: 'c2', name: 'No Number' }] })
  ok(noPhone.blocked === null, 'a missing number is not a block')
  ok(noPhone.tel === undefined, 'but there is still nothing to call')
}

/* --- 2. the raw builders are unreachable ---------------------------------- */

const src = readFileSync(join(root, 'src/lib/format.ts'), 'utf8')
ok(!/export function smsHref/.test(src), 'format.ts no longer exports smsHref')
ok(!/export function mailHref/.test(src), 'format.ts no longer exports mailHref')

/*
  Files allowed to import `telHref`. Team and Rep Detail call colleagues, who
  have no lead status and cannot be marked Do Not Contact; contact.ts is the
  sanctioned wrapper. Adding to this list is a deliberate, reviewable act — which
  is the entire point of it being a list.
*/
const TEL_ALLOWED = new Set([
  'src/lib/contact.ts',
  'src/screens/Team.tsx',
  'src/screens/RepDetail.tsx',
])

/* Hand-rolled links, for the same reason. AddMemberDialog mails a *teammate*
   an invite; that is not a homeowner and has no property attached. */
const RAW_ALLOWED = new Set([
  'src/lib/contact.ts',
  'src/lib/format.ts',
  'src/admin/AddMemberDialog.tsx',
])

function walk(dir) {
  const out = []
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, e.name)
    if (e.isDirectory()) out.push(...walk(full))
    else if (/\.tsx?$/.test(full)) out.push(full)
  }
  return out
}

const files = walk(join(root, 'src'))
ok(files.length > 50, 'the source tree was actually walked', `${files.length} files`)

const telImporters = []
const rawBuilders = []
for (const full of files) {
  const rel = relative(root, full).split('\\').join('/')
  const text = readFileSync(full, 'utf8')
  // Comments stripped first: this file's own prose names every symbol it bans,
  // and so do the explanatory comments left in format.ts and contact.ts.
  const code = text.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/^\s*\/\/[^\n]*$/gm, ' ')

  if (/import\s*\{[^}]*\btelHref\b[^}]*\}\s*from/.test(code)) telImporters.push(rel)
  if (/["'`](tel:|sms:|mailto:)/.test(code)) rawBuilders.push(rel)
}

const telStrays = telImporters.filter((f) => !TEL_ALLOWED.has(f))
ok(
  telStrays.length === 0,
  'telHref is imported only by files that call colleagues, never a homeowner screen',
  telStrays.length ? `stray: ${telStrays.join(', ')}` : telImporters.join(', '),
)
ok(telImporters.length > 0, 'and the import scan actually found telHref somewhere')

const rawStrays = rawBuilders.filter((f) => !RAW_ALLOWED.has(f))
ok(
  rawStrays.length === 0,
  'nothing hand-builds a tel:, sms: or mailto: link outside the sanctioned files',
  rawStrays.length ? `stray: ${rawStrays.join(', ')}` : rawBuilders.join(', '),
)

const usesWrapper = readFileSync(join(root, 'src/components/property/PropertyRow.tsx'), 'utf8')
ok(
  /homeownerContact\s*\(/.test(usesWrapper),
  'the list row gets its call link through homeownerContact, so the swipe obeys the block',
)

/* --- 3. the screen, in a browser ------------------------------------------ */

const browser = await chromium.launch({ executablePath: (await import('./lib/browser.mjs')).chromiumPath() })
const { dismissTour } = await import('./lib/tour.mjs')

const ctx = await browser.newContext({
  viewport: { width: 390, height: 844 },
  isMobile: true,
  hasTouch: true,
  serviceWorkers: 'block',
})
const page = await ctx.newPage()

await page.goto(BASE, { waitUntil: 'domcontentloaded' })
await page.waitForTimeout(1200)
await page.getByRole('button', { name: /Try the demo/ }).click()
await page.getByRole('button', { name: /Dana Whitfield/ }).click()
await dismissTour(page)
await page.waitForTimeout(1800)

/** Properties as the device actually stored them. */
const stored = await page.evaluate(
  () =>
    new Promise((res, rej) => {
      const req = indexedDB.open('allstar-field')
      req.onerror = () => rej(new Error('no db'))
      req.onsuccess = () => {
        const tx = req.result.transaction('properties', 'readonly')
        const all = tx.objectStore('properties').getAll()
        all.onsuccess = () => res(all.result)
        all.onerror = () => rej(new Error('read failed'))
      }
    }),
)

const hasPhone = (p) => (p.contacts ?? []).some((c) => c?.phone)
const dnc = stored.find((p) => p.status === 'dnc' && hasPhone(p))
const normal = stored.find((p) => p.status !== 'dnc' && hasPhone(p))

/*
  Both have to exist or the browser half proves nothing, so a missing fixture is
  a failure rather than a skip. "No tel: links on the page" is trivially true on
  a property with no phone number, which is the shape this gate would otherwise
  quietly take.
*/
ok(!!dnc, 'the demo data contains a Do Not Contact property that has a phone number', dnc?.address1)
ok(!!normal, 'and a contactable one that also has a phone number', normal?.address1)

/** Every live contact link on the current screen. */
const contactLinks = (p) =>
  p.$$eval('a[href]', (as) =>
    as.map((a) => a.getAttribute('href')).filter((h) => /^(tel:|sms:|mailto:)/.test(h ?? '')),
  )

if (dnc && normal) {
  await page.goto(`${BASE}/property/${normal.id}`, { waitUntil: 'domcontentloaded' })
  await page.waitForTimeout(1200)
  const allowed = await contactLinks(page)
  ok(allowed.length > 0, 'a contactable property offers live contact links', `${allowed.length} on screen`)
  ok(
    await page.getByTestId('contact-blocked').count() === 0,
    'and shows no Do Not Contact notice',
  )

  await page.goto(`${BASE}/property/${dnc.id}`, { waitUntil: 'domcontentloaded' })
  await page.waitForTimeout(1200)
  const blockedLinks = await contactLinks(page)
  ok(
    blockedLinks.length === 0,
    'a Do Not Contact property offers no call, text or email link at all',
    blockedLinks.length ? blockedLinks.join(', ') : 'none on screen',
  )
  ok(await page.getByTestId('contact-blocked').isVisible(), 'and says why, rather than just hiding the buttons')
  // Navigate stays: the block withdraws contact, not the address.
  ok(
    (await page.locator(`a[href*="/navigate/${dnc.id}"]`).count()) > 0,
    'while Navigate is still offered',
  )
}

await browser.close()

if (fails.length) {
  console.log(`\n${fails.length} failed:`)
  fails.forEach((f) => console.log(`  - ${f}`))
  process.exit(1)
}
console.log('\n=== Do Not Contact is enforced, not just recorded ===')
