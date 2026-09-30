import { chromium } from 'playwright'
import { chromiumPath } from './lib/browser.mjs'
import { dismissTour } from './lib/tour.mjs'

/**
 * The refinement pass, held to what it promised.
 *
 *   Empty lists say what is empty and what to do next: Leads with nothing
 *   matching offers to clear the search and filters, and does; a lead with no
 *   notes or visits says so in words, not a bare "none".
 *
 *   Screens that fetch show a placeholder the shape of what is coming, marked
 *   busy for a screen reader, and it stands still under Reduce Motion.
 *
 *   Help is its own tap: on the map it drops no pin, opens no sheet and moves
 *   nothing; while a territory is being drawn it adds no point. It still opens
 *   All Star Help.
 *
 *   A double tap on Save note writes one note.
 *
 *   The console's Team filters fold behind one button on a phone and stay out
 *   on a desktop.
 *
 *   On an iPad, portrait and landscape, mini to 12.9-inch: nothing scrolls
 *   sideways, the column stays readable, Help is in view and the rail is named.
 *
 *   With the keyboard up on a 320×568 and a 375×667 phone, every field on the
 *   sign-in, new lead, lead edit, appointment, invite, territory and search
 *   forms can be
 *   brought into what is left of the screen, uncovered.
 */

const BASE = process.env.BASE_URL || 'http://127.0.0.1:4173'
const fails = []
const ok = (cond, msg, measured) => {
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${msg}${measured ? `  (${measured})` : ''}`)
  if (!cond) fails.push(msg)
}

const browser = await chromium.launch({ executablePath: chromiumPath() })

async function signIn(name, width = 375, height = 667, extra = {}) {
  const ctx = await browser.newContext({ viewport: { width, height }, isMobile: width < 900, hasTouch: width < 900, serviceWorkers: 'block', ...extra })
  const page = await ctx.newPage()
  await page.route('**://maps.googleapis.com/**', (r) => r.abort())
  await page.goto(BASE, { waitUntil: 'domcontentloaded' })
  await page.waitForTimeout(1000)
  await page.getByRole('button', { name: /Try the demo/ }).click()
  await page.getByRole('button', { name }).click()
  await dismissTour(page)
  await page.waitForTimeout(1400)
  return { ctx, page }
}
const go = async (page, path) => {
  await page.goto(`${BASE}${path}`, { waitUntil: 'domcontentloaded' })
  await page.waitForTimeout(1300)
  await dismissTour(page)
}
const idb = (page, store) =>
  page.evaluate(
    (store) =>
      new Promise((res) => {
        const q = indexedDB.open('allstar-field')
        q.onsuccess = () => {
          const r = q.result.transaction(store).objectStore(store).getAll()
          r.onsuccess = () => res(r.result)
        }
      }),
    store,
  )

/** A keyboard that leaves `visible` px, the way `verify-keyboard` presents one. */
async function keyboard(page, visible) {
  await page.evaluate((h) => {
    const vv = window.visualViewport
    if (h == null) delete vv.__h
    else vv.__h = h
    if (!vv.__patched) {
      const own = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(vv), 'height')
      Object.defineProperty(vv, 'height', { configurable: true, get() { return this.__h ?? own.get.call(this) } })
      vv.__patched = true
    }
    vv.dispatchEvent(new Event('resize'))
  }, visible)
  await page.waitForTimeout(200)
}

/** Every text field in `scope`: can it be scrolled into what the keyboard leaves, with nothing on top of it? */
async function fieldsReachable(page, visible, scope = 'body') {
  return page.evaluate(
    ({ visible, scope }) => {
      const root = document.querySelector(scope) ?? document.body
      const fields = [...root.querySelectorAll('input, textarea, select')].filter((e) => {
        if (['checkbox', 'radio', 'hidden', 'file', 'range'].includes(e.type)) return false
        const r = e.getBoundingClientRect()
        return r.width > 0 && r.height > 0 && getComputedStyle(e).visibility !== 'hidden'
      })
      const bad = []
      for (const f of fields) {
        f.focus({ preventScroll: true })
        f.scrollIntoView({ block: 'nearest' })
        const r = f.getBoundingClientRect()
        const cx = Math.min(Math.max(r.left + r.width / 2, 1), innerWidth - 1)
        const cy = r.top + Math.min(r.height / 2, 12)
        const top = document.elementFromPoint(cx, cy)
        const covered = !top || !(top === f || f.contains(top) || top.contains(f) || top.closest('label')?.contains(f))
        if (r.top < -1 || r.bottom > visible + 1 || covered)
          bad.push(`${f.getAttribute('aria-label') || f.name || f.placeholder || f.type}: ${Math.round(r.top)}–${Math.round(r.bottom)}${covered ? ` under ${top?.tagName}.${(top?.className || '').toString().slice(0, 30)}` : ''}`)
        f.blur()
      }
      return { count: fields.length, bad }
    },
    { visible, scope },
  )
}

try {
  /* ===== empty states ======================================================= */
  {
    const { ctx, page } = await signIn(/Dana Whitfield/)
    await go(page, '/leads')
    await page.getByRole('searchbox').first().fill('zzzz no such street')
    await page.waitForTimeout(500)
    const empty = page.getByTestId('leads-empty')
    ok((await empty.count()) === 1 && /No leads match/.test(await empty.innerText()), 'Leads with nothing matching says so', await empty.innerText().catch(() => 'missing'))
    ok(/zzzz no such street/.test(await empty.innerText()), 'and names what was searched for')
    await empty.getByRole('button', { name: 'Clear search and filters' }).click()
    await page.waitForTimeout(500)
    ok((await page.getByTestId('leads-empty').count()) === 0 && (await page.getByRole('searchbox').first().inputValue()) === '', 'and its one button brings the list back')

    // A lead with no notes: the section says so and still offers Add note.
    const notes = await idb(page, 'notes')
    const props = await idb(page, 'properties')
    const withNotes = new Set(notes.map((n) => n.propertyId))
    const bare = props.find((p) => !withNotes.has(p.id))
    await go(page, `/property/${bare.id}`)
    const notesBtn = page.getByRole('button', { name: /^Notes/ }).first()
    if ((await notesBtn.getAttribute('aria-expanded')) === 'false') await notesBtn.click()
    await page.waitForTimeout(300)
    const ne = page.getByTestId('notes-empty')
    ok((await ne.count()) === 1 && /No notes yet/.test(await ne.innerText()), 'a lead with no notes says "No notes yet"')
    ok((await page.getByRole('button', { name: 'Add note', exact: true }).count()) >= 1, 'with Add note beside it')

    /* ===== one note per tap ================================================= */
    await go(page, `/property/${bare.id}?note=1`)
    await page.waitForTimeout(500)
    await page.locator('[role="dialog"] textarea').first().fill('Double tap check')
    const before = (await idb(page, 'notes')).filter((n) => n.propertyId === bare.id).length
    await page.getByRole('button', { name: 'Save note' }).dblclick()
    await page.waitForTimeout(900)
    const after = (await idb(page, 'notes')).filter((n) => n.propertyId === bare.id).length
    ok(after - before === 1, 'a double tap on Save note writes one note', `${after - before} written`)

    /* ===== Help is its own tap on the map =================================== */
    await go(page, '/map')
    await page.waitForTimeout(800)
    const snapshot = () =>
      page.evaluate(() => ({
        url: location.pathname + location.search,
        dialogs: document.querySelectorAll('[role="dialog"]').length,
        peek: document.querySelectorAll('[data-testid*="peek"]').length,
      }))
    const s0 = await snapshot()
    const [popup] = await Promise.all([
      page.waitForEvent('popup', { timeout: 4000 }).catch(() => null),
      page.getByTestId('help-button').first().tap(),
    ])
    await page.waitForTimeout(700)
    const s1 = await snapshot()
    // The sandbox cannot load the page itself, so: a new window opened, from the Help link.
    const href = await page.getByTestId('help-button').first().getAttribute('href')
    ok(!!popup && /support|help/i.test(href ?? ''), 'tapping Help on the map opens All Star Help in its own window', href)
    ok(JSON.stringify(s0) === JSON.stringify(s1), 'and the map under it does nothing: no pin, sheet, peek or navigation', `${JSON.stringify(s0)} → ${JSON.stringify(s1)}`)
    await popup?.close()
    await ctx.close()
  }

  /* ===== Help while drawing a territory ===================================== */
  {
    const { ctx, page } = await signIn(/Ray Okafor/)
    await go(page, '/admin/territories')
    await page.getByRole('button', { name: 'New territory' }).click()
    await page.waitForTimeout(700)
    const label = () => page.getByRole('button', { name: /Drop at least three points|Create with/ }).innerText()
    const before = await label()
    const [popup] = await Promise.all([
      page.waitForEvent('popup', { timeout: 4000 }).catch(() => null),
      page.getByTestId('help-button').first().tap(),
    ])
    await page.waitForTimeout(600)
    ok(!!popup, 'Help opens while a territory is being drawn')
    ok((await label()) === before && /Drop at least three points/.test(before), 'and adds no point to the drawing', `${before} → ${await label()}`)
    await popup?.close()

    /* ===== console Team filters on a phone ================================== */
    await go(page, '/admin/team')
    ok(await page.getByRole('searchbox', { name: 'Search the team' }).isVisible(), 'console Team keeps its search in view on a phone')
    const roleChip = page.getByRole('button', { name: 'All roles' })
    ok(!(await roleChip.isVisible()), 'and folds its role and status chips away')
    await page.getByTestId('console-team-filters').click()
    await page.waitForTimeout(300)
    ok(await roleChip.isVisible(), 'one tap on Filters shows them')
    await page.getByRole('button', { name: 'Field Rep', exact: true }).click()
    await page.waitForTimeout(300)
    ok(/Filters · 1/.test(await page.getByTestId('console-team-filters').innerText()), 'and the button counts what is on')
    await ctx.close()
  }
  {
    const { ctx, page } = await signIn(/Ray Okafor/, 1280, 900)
    await go(page, '/admin/team')
    ok((await page.getByRole('button', { name: 'All roles' }).isVisible()) && !(await page.getByTestId('console-team-filters').isVisible()), 'on a desktop the Team chips stay out, with no Filters button')
    await ctx.close()
  }

  /* ===== placeholders for screens that fetch ================================ */
  for (const reduced of [false, true]) {
    const ctx = await browser.newContext({ viewport: { width: 375, height: 667 }, serviceWorkers: 'block', reducedMotion: reduced ? 'reduce' : 'no-preference' })
    const page = await ctx.newPage()
    // Hold the badge lookup so the placeholder stays up long enough to look at.
    await page.route('**/*', (r) => (new URL(r.request().url()).hostname === '127.0.0.1' ? r.continue() : undefined))
    await page.goto(`${BASE}/verify/12345678`, { waitUntil: 'domcontentloaded' })
    await page.waitForTimeout(900)
    const sk = page.getByTestId('verify-loading').locator('[role="status"]')
    const shown = (await sk.count()) === 1
    const anim = shown ? await page.locator('.skeleton').first().evaluate((e) => getComputedStyle(e).animationName) : 'missing'
    if (!reduced) {
      ok(shown && (await sk.getAttribute('aria-busy')) === 'true', 'the badge check shows a placeholder, marked busy', await sk.innerText().catch(() => ''))
      ok(/Checking this badge/.test(await sk.innerText()), 'which a screen reader hears as "Checking this badge…"')
      ok(anim === 'skeleton-pulse', 'and it pulses gently', anim)
    } else {
      ok(shown && anim === 'none', 'under Reduce Motion the placeholder stands still', anim)
    }
    await ctx.close()
  }

  /* ===== iPad ============================================================== */
  // Built for the iPhone, and it has to hold up on an iPad: no sideways scroll,
  // a readable column rather than a stretched one, Help in view, a named rail,
  // and the console shortcut still first on More.
  for (const [w, h, name] of [[768, 1024, 'iPad mini portrait'], [820, 1180, 'iPad Air portrait'], [1180, 820, 'iPad Air landscape'], [1024, 1366, 'iPad Pro 12.9 portrait']]) {
    const issues = []
    for (const who of [/Dana Whitfield/, /Curtis Lane/]) {
      const { ctx, page } = await signIn(who, w, h)
      for (const path of ['/today', '/leads', '/map', '/more', '/admin']) {
        if (path === '/admin' && who.source.startsWith('Dana')) continue
        await go(page, path)
        const m = await page.evaluate(() => {
          const vw = document.documentElement.clientWidth
          const col = document.querySelector('.content-col')?.getBoundingClientRect()
          const help = document.querySelector('[data-testid="help-button"]')?.getBoundingClientRect()
          const rail = [...document.querySelectorAll('nav[aria-label="Primary"] a')].filter((a) => a.getBoundingClientRect().width > 0)
          return {
            side: document.documentElement.scrollWidth - vw,
            colW: col ? Math.round(col.width) : null,
            help: !!help && help.right <= vw && help.top >= 0,
            unnamed: rail.filter((a) => !(a.getAttribute('aria-label') || a.textContent?.trim())).length,
            rail: rail.length,
          }
        })
        const tag = `${who.source.split(' ')[0]} ${path}`
        if (m.side > 0) issues.push(`${tag} +${m.side}px sideways`)
        if (m.colW && m.colW > 720) issues.push(`${tag} column ${m.colW}px wide`)
        if (!m.help) issues.push(`${tag} Help out of view`)
        // The console has its own sidebar, not the field app's rail.
        if (!m.rail && path !== '/admin') issues.push(`${tag} no side rail`)
        if (m.unnamed) issues.push(`${tag} ${m.unnamed} unnamed rail links`)
      }
      if (who.source.startsWith('Curtis')) {
        await go(page, '/more')
        const c = await page.getByTestId('more-console').boundingBox()
        if (!c || c.y + c.height > h) issues.push('console shortcut not in view on More')
      }
      await ctx.close()
    }
    ok(issues.length === 0, `${name} (${w}×${h}): no sideways scroll, a readable column, Help in view, a named rail, the console first on More`, issues.join(' | ') || 'clean')
  }

  /* ===== keyboard on small phones =========================================== */
  for (const [w, h, kb] of [[320, 568, 268], [375, 667, 400]]) {
    const where = []
    const counted = []
    // Sign-in, before anybody is in.
    {
      const ctx = await browser.newContext({ viewport: { width: w, height: h }, isMobile: true, hasTouch: true, serviceWorkers: 'block' })
      const page = await ctx.newPage()
      await page.goto(BASE, { waitUntil: 'domcontentloaded' })
      await page.waitForTimeout(900)
      await keyboard(page, kb)
      const r = await fieldsReachable(page, kb)
      counted.push(`sign-in ${r.count}`)
      if (!r.count || r.bad.length) where.push(`sign-in: ${r.count} fields ${r.bad.join('; ')}`)
      await ctx.close()
    }
    // The admin: the only role with every one of these forms.
    const { ctx, page } = await signIn(/Curtis Lane/, w, h)
    const leadId = (await idb(page, 'properties'))[0]?.id
    const forms = [
      ['/lead/new', 'new lead', null],
      // Profile is live-only (the demo has none to edit): on the device checklist.
      ['/schedule/new', 'appointment', null],
      [`/property/${leadId}`, 'lead edit', async () => { await page.getByRole('button', { name: 'Edit details' }).first().click(); await page.waitForTimeout(600) }, '[role="dialog"]'],
      ['/leads', 'lead search', null],
      ['/admin/team', 'invite', async () => { await page.getByRole('button', { name: /Add team member/ }).first().click(); await page.waitForTimeout(600) }, '[role="dialog"]'],
      ['/admin/territories', 'territory name', async () => { await page.getByRole('button', { name: 'New territory' }).click(); await page.waitForTimeout(600) }],
    ]
    for (const [path, name, open, scope] of forms) {
      await go(page, path)
      if (open) await open()
      await keyboard(page, kb)
      const r = await fieldsReachable(page, kb, scope ?? 'body')
      counted.push(`${name} ${r.count}`)
      if (!r.count || r.bad.length) where.push(`${name}: ${r.count} fields ${r.bad.join('; ')}`)
      const side = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)
      if (side > 0) where.push(`${name}: +${side}px sideways`)
      await keyboard(page, null)
    }
    ok(where.length === 0, `${w}×${h} with the keyboard up: every field on sign-in, new lead, lead edit, appointment, search, invite and territory naming can be reached, uncovered`, where.join(' | ') || `fields checked: ${counted.join(', ')}`)
    await ctx.close()
  }
} catch (err) {
  console.error(err)
  fails.push(String(err))
} finally {
  await browser.close()
}

if (fails.length) {
  console.log(`\n${fails.length} failed:`)
  fails.forEach((f) => console.log(`  - ${f}`))
  process.exit(1)
}
console.log('\n=== empty states that help, placeholders that hold still, Help that is its own tap ===')
